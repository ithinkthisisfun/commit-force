// GITBOY browser fetch layer -- talks directly to api.github.com from the browser.
// No server, no OAuth: unauthenticated by default; an optional token (the visitor's
// own, kept in their browser) only ever goes to GitHub. Runs in Node too (global fetch).

import { assembleLevel, normalizeRepo } from "./gitboy-core.js";

const API = "https://api.github.com";

function headers(token) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}
async function gh(path, token) {
  const res = await fetch(API + path, { headers: headers(token) });
  if (res.status === 403 || res.status === 429) {
    const rem = res.headers.get("x-ratelimit-remaining");
    if (rem === "0") { const reset = +res.headers.get("x-ratelimit-reset") * 1000; throw new RateLimitError(reset); }
    throw new Error("GitHub returned 403 (forbidden) — likely the public rate limit; try again shortly.");
  }
  if (res.status === 404) throw new Error("Repo not found (or private).");
  if (!res.ok) throw new Error("GitHub error " + res.status);
  return res.json();
}
export class RateLimitError extends Error {
  constructor(resetMs) { super("GitHub's public rate limit reached — try again shortly"); this.resetMs = resetMs; }
}

// page through a list endpoint up to `max` items
async function paged(pathBase, token, max, onPage) {
  const per = 100, out = [];
  for (let page = 1; out.length < max; page++) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const arr = await gh(`${pathBase}${sep}per_page=${per}&page=${page}`, token);
    if (!Array.isArray(arr) || arr.length === 0) break;
    out.push(...arr);
    if (onPage) onPage(out.length);
    if (arr.length < per) break;
  }
  return out.slice(0, max);
}
// page a newest-first list, stopping once items fall before `cutoff` (or `max` is reached).
// `dateOf` picks the field the list is sorted by (updated_at), so we keep anything touched in-window.
async function pagedWindow(pathBase, token, max, cutoff, dateOf, onPage) {
  const per = 100, out = [];
  for (let page = 1; out.length < max; page++) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const arr = await gh(`${pathBase}${sep}per_page=${per}&page=${page}`, token);
    if (!Array.isArray(arr) || arr.length === 0) break;
    let hitOld = false;
    for (const it of arr) { if (dateOf(it) < cutoff) { hitOld = true; break; } out.push(it); if (out.length >= max) break; }
    if (onPage) onPage(out.length);
    if (hitOld || arr.length < per || out.length >= max) break;
  }
  return out;
}
async function searchTotal(repo, qextra, token) {
  const j = await gh(`/search/issues?q=${encodeURIComponent(`repo:${repo} ${qextra}`)}&per_page=1`, token);
  return j.total_count || 0;
}

// Step 1 of the picker: a cheap existence check (one request). Fast — enables the branch step.
export async function checkRepo(repoRaw, token = "") {
  const repo = normalizeRepo(repoRaw);
  if (!repo.includes("/")) throw new Error("enter a repo as owner/name");
  const info = await gh(`/repos/${repo}`, token);            // 404 throws
  return { repo, defaultBranch: info.default_branch, isPrivate: info.private };
}
// Step 2: the branch list (slower). Default branch first.
export async function getBranches(repoRaw, defaultBranch = "", token = "") {
  const repo = normalizeRepo(repoRaw);
  let names = [];
  try { names = (await paged(`/repos/${repo}/branches`, token, 100)).map(b => b.name); } catch (e) { if (e instanceof RateLimitError) throw e; }
  const def = defaultBranch || names[0] || "";
  return def ? [def, ...names.filter(n => n !== def)] : names;
}
// Optional heads-up counts — loaded in the background, never blocks the picker.
export async function getCounts(repoRaw, token = "") {
  const repo = normalizeRepo(repoRaw);
  let issues, prs;
  try { issues = await searchTotal(repo, "type:issue", token); prs = await searchTotal(repo, "type:pr", token); } catch (e) { if (e instanceof RateLimitError) throw e; }
  return { issues, prs };
}
// exact count via the pagination trick: per_page=1 -> the Link header's rel="last" page number IS the total.
async function pageCount(path, token) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${path}${sep}per_page=1`, { headers: headers(token) });
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get("x-ratelimit-remaining") === "0") throw new RateLimitError(+res.headers.get("x-ratelimit-reset") * 1000);
    throw new Error("GitHub 403");
  }
  if (!res.ok) return null;
  const m = (res.headers.get("Link") || "").match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (m) return +m[1];
  const arr = await res.json();
  return Array.isArray(arr) ? arr.length : 0;
}
// The hard caps a build applies; the picker warns before a range would blow past them.
export const CAPS = { issues: 150, prs: 150, commits: 500 };
// How much a time range holds -- cheap (search total_count + the commits Link-header trick), so the
// picker can warn before building. A field is null on a soft failure (count unknown); rate limits throw.
export async function windowCounts(repoRaw, windowDays, branch = "", token = "") {
  const repo = normalizeRepo(repoRaw);
  const since = new Date(Date.now() - windowDays * 86400000), day = since.toISOString().slice(0, 10);
  const sha = branch ? `&sha=${encodeURIComponent(branch)}` : "";
  const soft = e => { if (e instanceof RateLimitError) throw e; return null; };
  const [issues, prs, commits] = await Promise.all([
    searchTotal(repo, `type:issue updated:>${day}`, token).catch(soft),
    searchTotal(repo, `type:pr updated:>${day}`, token).catch(soft),
    pageCount(`/repos/${repo}/commits?since=${encodeURIComponent(since.toISOString())}${sha}`, token).catch(soft),
  ]);
  return { issues, prs, commits };
}
// Suggested repos: big, active, established projects with busy issue trackers — the ones
// that make the richest gauntlets. Highly-starred repos pushed this week, ranked by open
// help-wanted issues (which filters out the awesome-list/book repos that sort-by-stars
// surfaces). github.com/trending is HTML with no CORS, so this Search API query is the
// client-side stand-in. Fails soft: the caller keeps its seeds. Lightly rotated per load.
export async function getSuggestedRepos(token = "", count = 12) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`stars:>5000 pushed:>${since}`);
  const j = await gh(`/search/repositories?q=${q}&sort=help-wanted-issues&order=desc&per_page=30`, token);
  const pool = (j.items || []).map(r => ({ repo: r.full_name, stars: r.stargazers_count || 0 }));
  for (let i = pool.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [pool[i], pool[k]] = [pool[k], pool[i]]; }
  return pool.slice(0, count).sort((a, b) => b.stars - a.stars);
}
// Combined lookup (existence + branches + counts) — used by the CLI / back-compat.
export async function getRepoInfo(repoRaw, token = "") {
  const { repo, defaultBranch, isPrivate } = await checkRepo(repoRaw, token);
  const branches = await getBranches(repo, defaultBranch, token);
  const { issues, prs } = await getCounts(repo, token);
  return { repo, defaultBranch, branches, isPrivate, issues, prs };
}

// Fetch a repo's chosen window of activity (windowDays, default a year) and build a level. Everything is
// windowed by last-updated (so an old issue that's still being discussed stays in) and capped hard --
// no counting, no most-discussed fold-in. The core positions it all linearly, with no time-warps.
export async function buildLevelFromGitHub(repoRaw, { token = "", branch = "", windowDays = 365, onProgress = () => {} } = {}) {
  const repo = normalizeRepo(repoRaw);
  if (!repo.includes("/")) throw new Error("enter a repo as owner/name");
  const cutoff = Date.now() - windowDays * 86400000, cutoffISO = new Date(cutoff).toISOString();
  const updatedOf = x => new Date(x.updated_at || x.created_at).getTime();

  // The /issues endpoint returns PRs too — filter them out with .pull_request. `since` filters by
  // last-updated server-side; pagedWindow stops as soon as we page past the window.
  onProgress(8, "reading recent issues…");
  const issuesRaw = await pagedWindow(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(cutoffISO)}`,
    token, CAPS.issues + 60, cutoff, updatedOf, n => onProgress(8 + Math.min(20, n / CAPS.issues * 20), `reading issues… ${n}`));
  const mapIssue = i => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, labels: i.labels || [],
    author: i.user ? { login: i.user.login } : null, comments: i.comments, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at });
  const issues = issuesRaw.filter(i => !i.pull_request).slice(0, CAPS.issues).map(mapIssue);

  onProgress(34, "reading pull requests…");
  const prsRaw = await pagedWindow(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc`, token, CAPS.prs, cutoff, updatedOf);
  const prs = prsRaw.map(p => ({ number: p.number, title: p.title, state: p.state, author: p.user ? { login: p.user.login } : null,
    createdAt: p.created_at, closedAt: p.closed_at, mergedAt: p.merged_at }));

  onProgress(48, "reading releases…");
  let releases = [];
  try {
    const rel = await paged(`/repos/${repo}/releases`, token, 60);
    releases = rel.map(r => ({ tag: r.tag_name, name: r.name, pre: r.prerelease, publishedAt: r.published_at }));
  } catch (e) { if (e instanceof RateLimitError) throw e; }

  // Commits are optional garnish (the star shower); `since` windows them by commit date. ANY failure
  // here just skips the stars and reports why, rather than discarding the whole build.
  onProgress(58, "reading commits…");
  let commitList = [], commitError = null;
  try {
    const commitsPath = `/repos/${repo}/commits?since=${encodeURIComponent(cutoffISO)}${branch ? `&sha=${encodeURIComponent(branch)}` : ""}`;
    const comRaw = await paged(commitsPath, token, CAPS.commits, n => onProgress(58 + Math.min(30, n / CAPS.commits * 30), `reading commits… ${n}`));
    commitList = comRaw.map(c => ({ sha: (c.sha || "").slice(0, 7),
      date: c.commit?.author?.date || c.commit?.committer?.date,
      login: (c.author && c.author.login) || c.commit?.author?.name || "?",
      msg: (c.commit?.message || "").split("\n")[0] }));
  } catch (e) {
    commitError = (e instanceof RateLimitError) ? "hit GitHub's 60/hr limit before commits loaded" : "GitHub hiccuped reading commits";
  }

  onProgress(92, "building level…");
  const level = assembleLevel(repo, { issues, prs, commits: commitList, releases, windowDays });
  level.branch = branch || "";           // remembered so the game can build a shareable link
  if (commitError) level.commitsError = commitError;
  onProgress(100, "done");
  return level;
}
