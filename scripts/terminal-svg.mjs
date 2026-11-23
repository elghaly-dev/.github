// Renders a terminal-style contribution panel as a self-contained SVG.
// KIND: user = contribution calendar; repos = commits on default branches of public repos (orgs or users)
// Env: GITHUB_TOKEN, TARGET (login), KIND (user|org), OUT (path), TICKER (header label)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const { GITHUB_TOKEN, TARGET, KIND = 'user', OUT = 'profile/terminal.svg' } = process.env;
const TICKER = (process.env.TICKER || TARGET || '').toUpperCase();
if (!GITHUB_TOKEN || !TARGET) { console.error('GITHUB_TOKEN and TARGET required'); process.exit(1); }

async function gql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'terminal-svg' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const now = new Date();
const since = new Date(now.getTime() - 364 * 864e5);
const day = (d) => new Date(d).toISOString().slice(0, 10);
const daily = new Map(); // yyyy-mm-dd -> count
const repoTotals = new Map();

if (KIND === 'user') {
  const d = await gql(`query($l:String!,$f:DateTime!,$t:DateTime!){user(login:$l){contributionsCollection(from:$f,to:$t){
    contributionCalendar{weeks{contributionDays{date contributionCount}}}
    commitContributionsByRepository(maxRepositories:10){repository{nameWithOwner} contributions{totalCount}}}}}`,
    { l: TARGET, f: since.toISOString(), t: now.toISOString() });
  const c = d.user.contributionsCollection;
  for (const w of c.contributionCalendar.weeks) for (const x of w.contributionDays) daily.set(x.date, x.contributionCount);
  for (const r of c.commitContributionsByRepository) repoTotals.set(r.repository.nameWithOwner.split('/')[1], r.contributions.totalCount);
} else {
  const repos = [];
  let after = null;
  for (;;) {
    const d = await gql(`query($l:String!,$a:String){repositoryOwner(login:$l){repositories(first:50,after:$a,privacy:PUBLIC,isFork:false){
      pageInfo{hasNextPage endCursor} nodes{name defaultBranchRef{name}}}}}`, { l: TARGET, a: after });
    const p = d.repositoryOwner.repositories;
    repos.push(...p.nodes.filter((n) => n.defaultBranchRef));
    if (!p.pageInfo.hasNextPage) break;
    after = p.pageInfo.endCursor;
  }
  for (const repo of repos) {
    let cur = null, total = 0;
    for (let i = 0; i < 20; i++) {
      const d = await gql(`query($o:String!,$n:String!,$s:GitTimestamp!,$a:String){repository(owner:$o,name:$n){defaultBranchRef{target{... on Commit{
        history(first:100,since:$s,after:$a){pageInfo{hasNextPage endCursor} nodes{committedDate}}}}}}}`,
        { o: TARGET, n: repo.name, s: since.toISOString(), a: cur });
      const h = d.repository.defaultBranchRef.target.history;
      for (const n of h.nodes) { const k = day(n.committedDate); daily.set(k, (daily.get(k) || 0) + 1); total++; }
      if (!h.pageInfo.hasNextPage) break;
      cur = h.pageInfo.endCursor;
    }
    if (total) repoTotals.set(repo.name, total);
  }
}

// Weekly buckets (52 weeks ending today)
const W = 52;
const weeks = Array.from({ length: W }, () => ({ sum: 0, max: 0 }));
for (let i = 0; i < W * 7; i++) {
  const dt = new Date(now.getTime() - (W * 7 - 1 - i) * 864e5);
  const v = daily.get(day(dt)) || 0;
  const w = weeks[Math.floor(i / 7)];
  w.sum += v; w.max = Math.max(w.max, v);
}
const total = weeks.reduce((a, w) => a + w.sum, 0);
let streak = 0;
for (let i = 0; i < 400; i++) {
  const v = daily.get(day(new Date(now.getTime() - i * 864e5))) || 0;
  if (v > 0) streak++; else if (i === 0) continue; else break;
}
let best = 0, run = 0;
for (let i = W * 7 - 1; i >= 0; i--) {
  const v = daily.get(day(new Date(now.getTime() - i * 864e5))) || 0;
  run = v > 0 ? run + 1 : 0; best = Math.max(best, run);
}
const last = weeks[W - 1].sum, prev = weeks[W - 2].sum;
const up = last >= prev;
const top = [...repoTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

// Layout
const Wd = 900, H = 420;
const cx0 = 30, cx1 = 610, cy0 = 120, cy1 = 360;
const maxV = Math.max(1, ...weeks.map((w) => Math.max(w.sum, w.max)));
const X = (i) => cx0 + 6 + (i + 0.5) * ((cx1 - cx0 - 12) / W);
const Y = (v) => cy1 - (v / maxV) * (cy1 - cy0 - 10);
const bw = ((cx1 - cx0 - 12) / W) * 0.6;
const LIL = '#c4a7ff', LIL2 = '#8f6fe0', NAVY = '#0a1030', DIM = '#6b74a8';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let candles = '', pts = [];
weeks.forEach((w, i) => {
  const o = i ? weeks[i - 1].sum : w.sum, c = w.sum, hi = Math.max(w.max, o, c);
  const col = c >= o ? LIL : '#4a5280';
  const yb = Math.min(Y(o), Y(c)), hb = Math.max(1.5, Math.abs(Y(o) - Y(c)));
  candles += `<line x1="${X(i)}" x2="${X(i)}" y1="${Y(hi)}" y2="${Y(Math.min(o, c, 0))}" stroke="${col}" stroke-width="1" opacity=".55"/>`;
  candles += `<rect x="${X(i) - bw / 2}" y="${yb}" width="${bw}" height="${hb}" fill="${col}" opacity="${c >= o ? .85 : .7}"/>`;
  const a = weeks.slice(Math.max(0, i - 3), i + 1).reduce((s, x) => s + x.sum, 0) / Math.min(4, i + 1);
  pts.push(`${X(i).toFixed(1)},${Y(a).toFixed(1)}`);
});
let grid = '';
for (let g = 0; g <= 4; g++) {
  const y = cy0 + 10 + (g * (cy1 - cy0 - 10)) / 4;
  grid += `<line x1="${cx0}" x2="${cx1}" y1="${y}" y2="${y}" stroke="#1c2450" stroke-width="1"/><text x="${cx1 + 6}" y="${y + 4}" fill="${DIM}" font-size="10">${Math.round(maxV * (1 - g / 4))}</text>`;
}
const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
let ticks = '';
for (let i = 0; i < W; i += 13) {
  const dt = new Date(now.getTime() - (W * 7 - 1 - i * 7) * 864e5);
  ticks += `<text x="${X(i)}" y="${cy1 + 16}" fill="${DIM}" font-size="10" text-anchor="middle">${mon[dt.getUTCMonth()]}</text>`;
}
const topRows = top.length
  ? top.map(([n, v], i) => {
      const bwid = Math.max(4, (v / top[0][1]) * 90);
      return `<text x="650" y="${272 + i * 22}" fill="#cfd4f5" font-size="11">${esc(n.slice(0, 16))}</text><rect x="760" y="${263 + i * 22}" width="${bwid}" height="8" fill="${LIL2}" opacity=".85"/><text x="${766 + bwid}" y="${272 + i * 22}" fill="${DIM}" font-size="10">${v}</text>`;
    }).join('')
  : `<text x="650" y="272" fill="${DIM}" font-size="11">UNKNOWN</text>`;
const stat = (y, k, v) => `<text x="650" y="${y}" fill="${DIM}" font-size="10">${k}</text><text x="${Wd - 30}" y="${y}" fill="#fff" font-size="15" font-weight="700" text-anchor="end">${v}</text>`;
const tri = up ? '30,46 44,46 37,32' : '30,32 44,32 37,46';
const stamp = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" role="img" aria-label="${esc(TICKER)} weekly contributions chart">
<defs><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<rect width="${Wd}" height="${H}" rx="10" fill="${NAVY}" stroke="#222b66"/>
<rect x="0" y="0" width="${Wd}" height="64" rx="10" fill="#0e1540"/>
<text x="56" y="42" fill="${LIL}" font-family="Georgia,'Times New Roman',serif" font-size="26" font-weight="700" letter-spacing="2" filter="url(#glow)">${esc(TICKER)}  COMMITS</text>
<polygon points="${tri}" fill="${up ? '#9ef0c0' : '#ff9aa8'}"/>
<text x="${Wd - 30}" y="30" fill="${DIM}" font-size="11" text-anchor="end">WEEK ${last}  PREV ${prev}</text>
<text x="${Wd - 30}" y="48" fill="${DIM}" font-size="11" text-anchor="end">${stamp}</text>
<text x="30" y="92" fill="${DIM}" font-size="11">WEEKLY CONTRIBUTIONS  ·  52W  ·  CANDLES = WEEK VS PRIOR WEEK  ·  LINE = 4W AVERAGE</text>
${grid}${candles}
<polyline points="${pts.join(' ')}" fill="none" stroke="${LIL}" stroke-width="2.2" stroke-linejoin="round" filter="url(#glow)"/>
${ticks}
<line x1="635" x2="635" y1="84" y2="390" stroke="#1c2450"/>
<text x="650" y="100" fill="${LIL}" font-family="Georgia,serif" font-size="14" letter-spacing="1">STATS</text>
${stat(130, 'TOTAL 52W', total)}${stat(160, 'STREAK (DAYS)', streak)}${stat(190, 'BEST STREAK', best)}${stat(220, 'THIS WEEK', last)}
<text x="650" y="252" fill="${LIL}" font-family="Georgia,serif" font-size="14" letter-spacing="1">TOP REPOS</text>
${topRows}
<text x="30" y="${H - 14}" fill="#3d4580" font-size="10">SOURCE: GITHUB GRAPHQL · PUBLIC ACTIVITY · UPDATED DAILY</text>
</svg>
`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}: total=${total} streak=${streak} repos=${top.length}`);
