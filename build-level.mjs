#!/usr/bin/env node
// GITBOY `gh` pipeline -- a thin adapter that fetches via the authed `gh` CLI and
// feeds the shared transform (gitboy-core.js). For local/CLI use; the shipped
// browser flow uses gitboy-github.mjs instead (browser -> GitHub directly).
//
//   node build-level.mjs <owner/repo> [--limit N] [--commits N] [--prs N] [--out FILE]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assembleLevel, levelToJs, normalizeRepo } from "./gitboy-core.js";

const pexec = promisify(execFile);
async function ghJson(args) { const { stdout } = await pexec("gh", args, { maxBuffer: 128 * 1024 * 1024 }); return JSON.parse(stdout); }
const ghIssues = (repo, state, limit) => ghJson(["issue", "list", "--repo", repo, "--state", state, "--limit", String(limit),
  "--json", "number,title,state,labels,author,comments,createdAt,updatedAt,closedAt,url"]);
const ghPRs = (repo, limit) => ghJson(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(limit),
  "--json", "number,title,state,createdAt,closedAt,mergedAt,author"]);
const ghReleases = (repo, limit) => ghJson(["release", "list", "--repo", repo, "--limit", String(limit), "--json", "tagName,name,publishedAt,isPrerelease"]);
const ghCount = (repo, state) => ghJson(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} type:issue state:${state}`, "-f", "per_page=1", "--jq", ".total_count"]);
async function ghCommitsPage(repo, per, page) { try { return await ghJson(["api", `repos/${repo}/commits?per_page=${per}&page=${page}`]); } catch { return []; } }

export async function buildLevel({ repo, limit = 120, commits = 400, prLimit = 200, onProgress = () => {} }) {
  repo = normalizeRepo(repo);
  if (!repo.includes("/")) throw new Error("repo must be owner/name");

  onProgress(2, "counting issues…");
  let realOpen = 0, realClosed = 0;
  try { realOpen = await ghCount(repo, "open"); realClosed = await ghCount(repo, "closed"); } catch {}
  const budget = limit * 2;
  let openLim = limit, closedLim = limit;
  if (realOpen + realClosed > 0) { openLim = Math.max(5, Math.min(budget - 5, Math.round(budget * realOpen / (realOpen + realClosed)))); closedLim = budget - openLim; }

  onProgress(6, "reading open issues…");
  const open = await ghIssues(repo, "open", openLim);
  onProgress(12, "reading closed issues…");
  const closed = await ghIssues(repo, "closed", closedLim);
  onProgress(16, "reading pull requests…");
  let prs = []; try { prs = await ghPRs(repo, prLimit); } catch {}
  onProgress(18, "reading releases…");
  let rels = []; try { rels = await ghReleases(repo, 60); } catch {}

  onProgress(22, "reading commits…");
  const per = 100, pages = Math.max(1, Math.ceil(commits / per));
  let raw = [];
  for (let p = 1; p <= pages; p++) {
    const arr = await ghCommitsPage(repo, per, p);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const c of arr) raw.push({ sha: (c.sha || "").slice(0, 7), date: c.commit?.author?.date || c.commit?.committer?.date,
      login: (c.author && c.author.login) || c.commit?.author?.name || "?", msg: (c.commit?.message || "").split("\n")[0] });
    onProgress(22 + Math.round(64 * p / pages), `reading commits… ${raw.length}`);
    if (arr.length < per) break;
  }
  const commitList = raw.filter(c => c.date).slice(0, commits);

  onProgress(90, "building level…");
  const releases = rels.map(r => ({ tag: r.tagName, name: r.name, pre: r.isPrerelease, publishedAt: r.publishedAt }));
  const level = assembleLevel(repo, { issues: [...open, ...closed], prs, commits: commitList, releases, realOpen, realClosed });
  onProgress(100, "done");
  return level;
}
export { levelToJs };

// ---- CLI ----------------------------------------------------------------
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const repo = argv.find(a => !a.startsWith("--"));
  const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (!repo) { console.error("usage: node build-level.mjs <owner/repo> [--limit N] [--commits N] [--prs N] [--out FILE]"); process.exit(1); }
  buildLevel({
    repo, limit: parseInt(opt("limit", "120"), 10), commits: parseInt(opt("commits", "400"), 10), prLimit: parseInt(opt("prs", "200"), 10),
    onProgress: (p, m) => process.stderr.write(`\rGITBOY ${String(p).padStart(3)}%  ${m}                    `),
  }).then(level => {
    writeFileSync(opt("out", "level-data.js"), levelToJs(level));
    const c = level.counts;
    process.stderr.write(`\nGITBOY: ${c.total} trucks (${c.closed} closed, ${c.open} open) at real ratio ${c.realClosed}:${c.realOpen}; ${c.commits} stars (${c.bots} bot), ${c.prs} planes, ${c.releases} releases; ${level.span.days}-day window\n`);
  }).catch(e => { console.error("\nGITBOY error:", e.message || e); process.exit(1); });
}
