#!/usr/bin/env node
// Draws the GitHub stats + top languages cards as static SVGs (light and dark).
// Runs in a scheduled GitHub Action, so the profile never depends on a hosted
// stats service and its rate limits.
//
// Usage: GH_TOKEN=... GH_USER=ryenguyen7411 node scripts/generate-cards.mjs
// A token with read access to private repos counts private work too;
// the Action's default GITHUB_TOKEN only sees public data.

import { mkdir, writeFile } from 'node:fs/promises';

const TOKEN = process.env.GH_TOKEN;
const USER = process.env.GH_USER ?? 'ryenguyen7411';
const OUT_DIR = process.env.OUT_DIR ?? 'assets/cards';
const HIDDEN_LANGUAGES = new Set(['PHP', 'HTML', 'CSS', 'SCSS', 'Shell', 'Dockerfile', 'Makefile']);
const TOP_LANGUAGES = 6;

if (!TOKEN) {
  console.error('GH_TOKEN is not set');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

async function fetchProfile() {
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        pullRequests(states: MERGED) { totalCount }
        contributionsCollection {
          contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } }
        }
      }
    }`,
    { login: USER },
  );
  return data.user;
}

async function fetchRepos() {
  const repos = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login: USER, cursor },
    );
    const page = data.user.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
}

async function fetchAllTimeContributions(createdAt) {
  const startYear = new Date(createdAt).getUTCFullYear();
  const now = new Date();
  let total = 0;
  for (let year = startYear; year <= now.getUTCFullYear(); year++) {
    const from = new Date(Date.UTC(year, 0, 1)).toISOString();
    const to = year === now.getUTCFullYear() ? now.toISOString() : new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) { contributionCalendar { totalContributions } }
        }
      }`,
      { login: USER, from, to },
    );
    total += data.user.contributionsCollection.contributionCalendar.totalContributions;
  }
  return total;
}

function streaks(weeks) {
  const days = weeks.flatMap((w) => w.contributionDays);
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today may have no contributions yet; the streak still counts from yesterday.
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;
  return { current, longest };
}

function languageShares(repos) {
  const totals = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      if (HIDDEN_LANGUAGES.has(node.name)) continue;
      const prev = totals.get(node.name) ?? { size: 0, count: 0, color: node.color ?? '#8b949e' };
      totals.set(node.name, { size: prev.size + size, count: prev.count + 1, color: prev.color });
    }
  }
  // Weight by sqrt(bytes) * sqrt(repo count), so one repo with vendored or
  // generated code does not outweigh languages used across many projects.
  const scored = [...totals.entries()].map(([name, v]) => [name, { ...v, score: Math.sqrt(v.size) * Math.sqrt(v.count) }]);
  const sorted = scored.sort((a, b) => b[1].score - a[1].score);
  const sum = sorted.reduce((acc, [, v]) => acc + v.score, 0) || 1;
  const top = sorted.slice(0, TOP_LANGUAGES).map(([name, v]) => ({ name, color: v.color, pct: (v.score / sum) * 100 }));
  const rest = 100 - top.reduce((acc, l) => acc + l.pct, 0);
  if (sorted.length > TOP_LANGUAGES && rest >= 0.5) top.push({ name: 'Other', color: '#8b949e', pct: rest });
  return top;
}

const THEMES = {
  dark: { bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#ffd43b', accent2: '#9d8cff', track: '#21262d' },
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#59636e', accent: '#b78103', accent2: '#6e5ce6', track: '#eaeef2' },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const W = 420;
const H = 210;

const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n.toLocaleString('en-US'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frame(t, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
  <style>
    text { font-family: ${FONT}; }
    .title { font-size: 15px; font-weight: 600; fill: ${t.text}; }
    .label { font-size: 12px; fill: ${t.muted}; }
    .value { font-size: 20px; font-weight: 700; fill: ${t.text}; }
    .lang { font-size: 12px; fill: ${t.text}; }
    .pct { font-size: 12px; fill: ${t.muted}; }
    .foot { font-size: 10px; fill: ${t.muted}; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
  <rect x="24" y="22" width="4" height="16" rx="2" fill="${t.accent}"/>
  <text x="36" y="35" class="title">${esc(title)}</text>
${body}
</svg>
`;
}

function statsCard(t, s) {
  const cells = [
    ['Contributions (1y)', fmt(s.yearContributions), t.accent],
    ['All-time contributions', fmt(s.allTime), t.text],
    ['Current streak', `${s.streak.current}d`, t.accent2],
    ['Longest streak (1y)', `${s.streak.longest}d`, t.text],
    ['PRs merged', fmt(s.prsMerged), t.text],
    ['Followers', fmt(s.followers), t.text],
  ];
  const colX = [24, 158, 292];
  const rowY = [62, 122];
  const body = cells
    .map(([label, value, color], i) => {
      const x = colX[i % 3];
      const y = rowY[Math.floor(i / 3)];
      return `  <text x="${x}" y="${y + 24}" class="value" fill="${color}" style="fill:${color}">${esc(value)}</text>
  <text x="${x}" y="${y + 42}" class="label">${esc(label)}</text>`;
    })
    .join('\n');
  const foot = `  <text x="24" y="${H - 14}" class="foot">${fmt(s.stars)} stars on own repos · updated ${s.updated}</text>`;
  return frame(t, 'GitHub activity', `${body}\n${foot}`);
}

function languagesCard(t, langs, updated) {
  const barX = 24;
  const barW = W - 48;
  let x = barX;
  const segments = langs
    .map((l) => {
      const w = Math.max((l.pct / 100) * barW, 2);
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join('');
  const bar = `  <clipPath id="bar"><rect x="${barX}" y="56" width="${barW}" height="8" rx="4"/></clipPath>
  <rect x="${barX}" y="56" width="${barW}" height="8" rx="4" fill="${t.track}"/>
  <g clip-path="url(#bar)"><g transform="translate(0 56)">${segments}</g></g>`;
  const items = langs
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const ix = 24 + col * 196;
      const iy = 92 + row * 24;
      return `  <circle cx="${ix + 5}" cy="${iy - 4}" r="5" fill="${l.color}"/>
  <text x="${ix + 16}" y="${iy}" class="lang">${esc(l.name)}</text>
  <text x="${ix + 172}" y="${iy}" class="pct" text-anchor="end">${l.pct.toFixed(1)}%</text>`;
    })
    .join('\n');
  const foot = `  <text x="24" y="${H - 14}" class="foot">Weighted by code size and repo count · updated ${updated}</text>`;
  return frame(t, 'Top languages', `${bar}\n${items}\n${foot}`);
}

async function main() {
  const [profile, repos] = await Promise.all([fetchProfile(), fetchRepos()]);
  const allTime = await fetchAllTimeContributions(profile.createdAt);
  const cc = profile.contributionsCollection;
  const updated = new Date().toISOString().slice(0, 10);
  const stats = {
    yearContributions: cc.contributionCalendar.totalContributions,
    allTime,
    prsMerged: profile.pullRequests.totalCount,
    followers: profile.followers.totalCount,
    stars: repos.reduce((acc, r) => acc + r.stargazerCount, 0),
    streak: streaks(cc.contributionCalendar.weeks),
    updated,
  };
  const langs = languageShares(repos);

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, t] of Object.entries(THEMES)) {
    await writeFile(`${OUT_DIR}/stats-${name}.svg`, statsCard(t, stats));
    await writeFile(`${OUT_DIR}/languages-${name}.svg`, languagesCard(t, langs, updated));
  }
  console.log(JSON.stringify({ ...stats, langs: langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
