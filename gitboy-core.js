// GITBOY shared core -- the pure transform, no I/O. Runs in Node and the browser.
// Both the `gh` pipeline (build-level.mjs) and the browser fetch layer
// (gitboy-github.mjs) collect raw data, normalize it to the shapes below, and
// call assembleLevel(). Keep this dependency-free.
//
// Normalized inputs:
//   issue    { number, title, url, state, labels:[{name}], author:{login}|null,
//              comments:(Number|Array), createdAt, updatedAt, closedAt }
//   pr       { number, title, state, author:{login}|null, createdAt, closedAt, mergedAt }
//   commit   { sha, date, login, msg }
//   release  { tag, name, pre, publishedAt }

export const DAY = 86400000, HOUR = 3600000;

const BUG_RE  = /(bug|defect|crash|regression|broken|error|fix|cors|leak|security|vuln|fail)/i;
const FEAT_RE = /(enhanc|feature|feat|improv|perf|ux|ui|design|support|add )/i;
const DOCS_RE = /(doc|readme|guide|spec|wording|reconcile)/i;
const SQUADS = {
  bug:  { name: "Bug Squad",    color: "#c92b2b" },
  feat: { name: "Feature Team", color: "#2f7fd8" },
  docs: { name: "Docs Crew",    color: "#159c9c" },
  task: { name: "Chores",       color: "#d9a021" },
};

export const isBot = s => /\[bot\]|dependabot|renovate|github-actions|greenkeeper|snyk-bot/i.test(s || "");
export function normalizeRepo(s) {
  s = (s || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = s.match(/github\.com[/:]+([^/]+\/[^/#?]+)/i);
  return m ? m[1] : s;
}
const commentCount = c => Array.isArray(c) ? c.length : (c || 0);

function categorize(labels, title) {
  const L = (labels || []).map(l => (l.name || l || "").toLowerCase());
  if (L.some(x => /bug|defect|regression|crash|security/.test(x))) return "bug";
  if (L.some(x => /enhanc|feature|feat/.test(x)))                   return "feat";
  if (L.some(x => /doc/.test(x)))                                   return "docs";
  const t = title || "";
  if (BUG_RE.test(t))  return "bug";
  if (DOCS_RE.test(t)) return "docs";
  if (FEAT_RE.test(t)) return "feat";
  return "task";
}
function difficulty(issue, now) {
  const start = new Date(issue.createdAt).getTime();
  const end = issue.closedAt ? new Date(issue.closedAt).getTime() : now;
  const ageDays = Math.max(0, (end - start) / DAY), c = commentCount(issue.comments);
  let s = 0; if (c >= 2) s++; if (c >= 6) s++; if (ageDays >= 14) s++; if (ageDays >= 90) s++;
  return Math.max(1, Math.min(3, 1 + Math.floor(s / 1.5)));
}

export function assembleLevel(repo, { issues = [], prs = [], commits = [], releases = [], realOpen = 0, realClosed = 0 } = {}) {
  repo = normalizeRepo(repo);
  const now = Date.now();

  // trucks appear when the issue OPENS; PRs seed the axis too
  const workEpochs = [...new Set([
    ...issues.map(i => new Date(i.createdAt).getTime()),
    ...prs.map(p => new Date(p.createdAt).getTime()),
  ])].sort((a, b) => a - b);
  const allEpochs = [...workEpochs, ...commits.map(c => new Date(c.date).getTime())];
  const t0 = workEpochs.length ? workEpochs[0] : (allEpochs.length ? Math.min(...allEpochs) : now);
  const t1 = workEpochs.length ? workEpochs[workEpochs.length - 1] : (allEpochs.length ? Math.max(...allEpochs) : now);
  const span = Math.max(1, t1 - t0);
  let frac, timeline;
  if (workEpochs.length < 2) {
    frac = ms => (ms - t0) / span;
    timeline = { breaks: [{ t: 0, ms: t0 }, { t: 1, ms: t1 }], skips: [] };
  } else {
    const ev = workEpochs;
    const gaps = []; for (let i = 1; i < ev.length; i++) gaps.push(ev[i] - ev[i - 1]);
    const med = [...gaps].sort((a, b) => a - b)[gaps.length >> 1] || DAY;
    const CAP = Math.max(3 * DAY, med * 4);
    // gaps longer than CAP are "skips" (a quiet stretch). Normal gaps keep their real (sub-CAP)
    // width on the axis, but each skip collapses to a tiny fixed SEAM so a multi-year silence
    // becomes ~one ground-block of track -- the player brackets it with dashed lines instead of
    // making you run across dead space. SEAM scales with the non-skip span so the seam stays
    // ~1-2 blocks wide on the default track length no matter how busy the repo is.
    let base = 0;
    for (let i = 1; i < ev.length; i++) { const gap = ev[i] - ev[i - 1]; if (gap <= CAP) base += gap; }
    const SEAM = Math.max(HOUR, base * 0.0018);
    const wid = [0]; for (let i = 1; i < ev.length; i++) { const gap = ev[i] - ev[i - 1]; wid[i] = gap > CAP ? SEAM : gap; }
    const C = [0]; for (let i = 1; i < ev.length; i++) C[i] = C[i - 1] + wid[i];
    const totalC = C[C.length - 1] || 1;
    frac = x => {
      if (x <= ev[0]) return 0;
      if (x >= ev[ev.length - 1]) return 1;
      let lo = 0, hi = ev.length - 1;
      while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (ev[m] <= x) lo = m; else hi = m; }
      const seg = ev[hi] - ev[lo], f = seg > 0 ? (x - ev[lo]) / seg : 0;
      return (C[lo] + f * wid[hi]) / totalC;
    };
    // timeline metadata for playback: `breaks` are knots mapping track position (t) -> real time
    // (ms), so the player can show a live date; `skips` are the gaps that got clamped (realGap >
    // CAP) -- the player flashes as the runner crosses one, since a lot of real time passes there
    // in very little track. The map is piecewise-linear between knots, exactly inverting frac().
    timeline = { breaks: ev.map((ms, i) => ({ t: C[i] / totalC, ms })), skips: [] };
    for (let i = 1; i < ev.length; i++) {
      const gap = ev[i] - ev[i - 1];
      if (gap > CAP) timeline.skips.push({ t0: C[i - 1] / totalC, t1: C[i] / totalC, from: ev[i - 1], to: ev[i], gapDays: Math.round(gap / DAY) });
    }
  }

  const obstacles = issues.map(issue => {
    const closedState = (issue.state || "").toLowerCase() === "closed";
    const cat = categorize(issue.labels, issue.title);
    const diff = difficulty(issue, now);
    const createdMs = new Date(issue.createdAt).getTime();
    const closedMs = issue.closedAt ? new Date(issue.closedAt).getTime() : createdMs;
    const updatedMs = issue.updatedAt ? new Date(issue.updatedAt).getTime() : createdMs;
    const comments = commentCount(issue.comments);
    let engage, resolves;
    if (closedState) { engage = true; resolves = true; }
    else { engage = comments > 0 || (updatedMs - createdMs) > HOUR; resolves = false; }
    return {
      n: issue.number, title: issue.title, url: issue.url, author: issue.author?.login || "",
      state: closedState ? "closed" : "open",
      kind: "truck", hero: cat, diff, comments, size: comments >= 6 ? 3 : comments >= 2 ? 2 : 1,
      t: frac(createdMs),
      life: closedState ? Math.max(0, frac(closedMs) - frac(createdMs)) : 0,
      engage, resolves, labels: (issue.labels || []).map(l => l.name || l),
    };
  });
  obstacles.sort((a, b) => a.t - b.t);

  const order = ["bug", "feat", "docs", "task"];
  const counts = {}; obstacles.forEach(o => counts[o.hero] = (counts[o.hero] || 0) + 1);
  const heroes = order.filter(c => counts[c]).map(c => ({ id: c, name: SQUADS[c].name, color: SQUADS[c].color, count: counts[c], real: true }));
  if (heroes.length === 0) heroes.push({ id: "task", name: SQUADS.task.name, color: SQUADS.task.color, count: 0, real: true });
  const lead = [...heroes].sort((a, b) => b.count - a.count)[0].id;

  const stars = commits
    .filter(c => c.date).map(c => ({ ...c, ms: new Date(c.date).getTime() }))
    .filter(c => c.ms >= t0 - DAY && c.ms <= t1 + DAY)
    .map(c => ({ sha: c.sha, login: c.login, msg: c.msg, bot: isBot(c.login), t: frac(c.ms) }))
    .sort((a, b) => a.t - b.t);

  const planes = prs.map(p => {
    const st = p.mergedAt ? "merged" : ((p.state || "").toLowerCase() === "open" ? "open" : "rejected");
    const createdMs = new Date(p.createdAt).getTime();
    const endMs = p.mergedAt ? new Date(p.mergedAt).getTime() : (p.closedAt ? new Date(p.closedAt).getTime() : createdMs);
    return { n: p.number, title: p.title, state: st, author: p.author?.login || "", t: frac(createdMs), endT: Math.max(frac(createdMs), frac(endMs)) };
  }).sort((a, b) => a.t - b.t);

  const rel = releases
    .filter(r => r.publishedAt).map(r => ({ ...r, ms: new Date(r.publishedAt).getTime() }))
    .filter(r => r.ms >= t0 - DAY && r.ms <= t1 + DAY)
    .map(r => ({ tag: r.tag, name: r.name || r.tag, pre: !!r.pre, t: frac(r.ms) }))
    .sort((a, b) => a.t - b.t);

  // the boss is the most-discussed issue, PERIOD (open or closed). If it never closed, the rig escapes
  // in-game ("we didn't blow it up last sprint...") -- see the flee/boom split in play.html.
  let boss = null;
  for (const o of obstacles) if (!boss || o.comments > boss.comments) boss = o;
  if (boss && boss.comments >= 2) boss.boss = true;

  const closedN = obstacles.filter(o => o.state === "closed").length;
  const openN = obstacles.filter(o => o.state === "open").length;
  const openActiveN = obstacles.filter(o => o.state === "open" && o.engage).length;

  return {
    repo, generatedAt: new Date(now).toISOString(),
    span: { start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), days: Math.round(span / DAY) },
    counts: {
      total: obstacles.length, closed: closedN, open: openN, openActive: openActiveN, idle: openN - openActiveN,
      commits: stars.length, bots: stars.filter(s => s.bot).length,
      prs: planes.length, prMerged: planes.filter(p => p.state === "merged").length, prRejected: planes.filter(p => p.state === "rejected").length,
      releases: rel.length, realOpen, realClosed,
    },
    heroes, lead, obstacles, stars, planes, releases: rel, timeline,
  };
}

export const levelToJs = level => "window.GITBOY_LEVEL = " + JSON.stringify(level) + ";\n";
