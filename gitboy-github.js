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
async function count(repo, state, token) {
  const q = encodeURIComponent(`repo:${repo} type:issue state:${state}`);
  const j = await gh(`/search/issues?q=${q}&per_page=1`, token);
  return j.total_count || 0;
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
// Combined lookup (existence + branches + counts) — used by the CLI / back-compat.
export async function getRepoInfo(repoRaw, token = "") {
  const { repo, defaultBranch, isPrivate } = await checkRepo(repoRaw, token);
  const branches = await getBranches(repo, defaultBranch, token);
  const { issues, prs } = await getCounts(repo, token);
  return { repo, defaultBranch, branches, isPrivate, issues, prs };
}

// Fetch a repo's data straight from the browser and build a level.
export async function buildLevelFromGitHub(repoRaw, { token = "", limit = 100, commits = 400, prLimit = 200, branch = "", onProgress = () => {} } = {}) {
  const repo = normalizeRepo(repoRaw);
  if (!repo.includes("/")) throw new Error("enter a repo as owner/name");

  onProgress(3, "counting issues…");
  let realOpen = 0, realClosed = 0;
  try { realOpen = await count(repo, "open", token); realClosed = await count(repo, "closed", token); } catch (e) { if (e instanceof RateLimitError) throw e; }
  const budget = limit * 2;
  let openLim = limit, closedLim = limit;
  if (realOpen + realClosed > 0) {
    openLim = Math.max(5, Math.min(budget - 5, Math.round(budget * realOpen / (realOpen + realClosed))));
    closedLim = budget - openLim;
  }

  // The /issues endpoint returns PRs too — filter them out with .pull_request.
  onProgress(8, "reading open issues…");
  const openRaw = await paged(`/repos/${repo}/issues?state=open&sort=created&direction=desc`, token, openLim + 40);
  onProgress(18, "reading closed issues…");
  const closedRaw = await paged(`/repos/${repo}/issues?state=closed&sort=created&direction=desc`, token, closedLim + 40);
  const mapIssue = i => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, labels: i.labels || [],
    author: i.user ? { login: i.user.login } : null, comments: i.comments, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at });
  const issues = [
    ...openRaw.filter(i => !i.pull_request).slice(0, openLim).map(mapIssue),
    ...closedRaw.filter(i => !i.pull_request).slice(0, closedLim).map(mapIssue),
  ];

  onProgress(34, "reading pull requests…");
  const prsRaw = await paged(`/repos/${repo}/pulls?state=all&sort=created&direction=desc`, token, prLimit);
  const prs = prsRaw.map(p => ({ number: p.number, title: p.title, state: p.state, author: p.user ? { login: p.user.login } : null,
    createdAt: p.created_at, closedAt: p.closed_at, mergedAt: p.merged_at }));

  onProgress(48, "reading releases…");
  let releases = [];
  try {
    const rel = await paged(`/repos/${repo}/releases`, token, 60);
    releases = rel.map(r => ({ tag: r.tag_name, name: r.name, pre: r.prerelease, publishedAt: r.published_at }));
  } catch (e) { if (e instanceof RateLimitError) throw e; }

  // Commits are optional garnish (the star shower). By the time we get here the essential
  // data (trucks, planes) is already loaded, so ANY failure here — a transient 404 or even
  // hitting the rate limit — just skips the stars and reports why, rather than discarding
  // the whole build.
  onProgress(58, "reading commits…");
  let commitList = [], commitError = null;
  try {
    const commitsPath = `/repos/${repo}/commits${branch ? `?sha=${encodeURIComponent(branch)}` : ""}`;
    const comRaw = await paged(commitsPath, token, commits, n => onProgress(58 + Math.min(30, n / commits * 30), `reading commits… ${n}`));
    commitList = comRaw.map(c => ({ sha: (c.sha || "").slice(0, 7),
      date: c.commit?.author?.date || c.commit?.committer?.date,
      login: (c.author && c.author.login) || c.commit?.author?.name || "?",
      msg: (c.commit?.message || "").split("\n")[0] }));
  } catch (e) {
    commitError = (e instanceof RateLimitError) ? "hit GitHub's 60/hr limit before commits loaded" : "GitHub hiccuped reading commits";
  }

  onProgress(92, "building level…");
  const level = assembleLevel(repo, { issues, prs, commits: commitList, releases, realOpen, realClosed });
  level.branch = branch || "";           // remembered so the game can build a shareable link
  if (commitError) level.commitsError = commitError;
  onProgress(100, "done");
  return level;
}
