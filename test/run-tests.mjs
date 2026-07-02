// Commit Force -- offline test runner. DEV-ONLY. Starts the mock GitHub, points the real fetch layer
// at it (via globalThis.__GH_API), and asserts the behaviour we can't check against live GitHub
// (rate limits, no token). Run:  node run-tests.mjs
import { startMock } from "./mock-github.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? "  -- " + extra : "")); } };

const mock = await startMock({ port: 0 });
globalThis.__GH_API = mock.url;                 // MUST be set before importing the fetch layer
console.log("mock GitHub at " + mock.url + "  (" + mock.seed.issues.length + " issues / " + mock.seed.prs.length + " PRs / " + mock.seed.commits.length + " commits)\n");

const { checkRepo, getBranches, windowCounts, buildLevelFromGitHub, RateLimitError } = await import("../gitboy-github.js");

const REPO = "acme/widgets", DAY = 86400000, NOW = Date.parse("2026-07-01T00:00:00Z");
const win = d => ({ start: NOW - d * DAY, end: NOW });

try {
  const info = await checkRepo(REPO, "t");
  ok("checkRepo -> default branch main", info.defaultBranch === "main", JSON.stringify(info));
  const branches = await getBranches(REPO, info.defaultBranch, "t");
  ok("getBranches lists branches (default first)", branches[0] === "main" && branches.includes("develop"), branches.join(","));

  // size gate counts must grow with the range (search total_count + commits Link-header count)
  const c7 = await windowCounts(REPO, NOW - 7 * DAY, NOW, "main", "t");
  const c90 = await windowCounts(REPO, NOW - 90 * DAY, NOW, "main", "t");
  ok("windowCounts returns numbers", [c7.issues, c7.prs, c7.commits].every(x => typeof x === "number"), JSON.stringify(c7));
  ok("windowCounts issues grow with range", c90.issues > c7.issues, `7d=${c7.issues} 90d=${c90.issues}`);
  ok("windowCounts commits grow with range (Link-header count works)", c90.commits > c7.commits, `7d=${c7.commits} 90d=${c90.commits}`);

  const L7 = await buildLevelFromGitHub(REPO, { branch: "main", token: "t", ...win(7) });
  const L90 = await buildLevelFromGitHub(REPO, { branch: "main", token: "t", ...win(90) });
  ok("build: wider range -> more trucks", L90.counts.total > L7.counts.total, `7d=${L7.counts.total} 90d=${L90.counts.total}`);
  ok("build: wider range -> more stars", L90.counts.commits > L7.counts.commits, `7d=${L7.counts.commits} 90d=${L90.counts.commits}`);
  ok("build: PAGINATES (90d total >> one page of 100)", L90.counts.total > 200, `total=${L90.counts.total}`);
  ok("build: NOT truncated to 150 issues (soft-cap only)", L90.counts.total > 150, `total=${L90.counts.total}`);
  ok("build: NOT truncated to 500 commits (soft-cap only)", L90.counts.commits > 500, `commits=${L90.counts.commits}`);
  ok("build: star count ~= windowCounts commits (fetch == count)", Math.abs(L90.counts.commits - c90.commits) < 60, `stars=${L90.counts.commits} count=${c90.commits}`);
  ok("build: span days == picked window (not the data extent)", L90.span.days === 90, `span=${L90.span.days}`);
  ok("build: no time-warp seams (linear windowed model)", Array.isArray(L90.timeline.skips) && L90.timeline.skips.length === 0);
  const boss = L90.obstacles.find(o => o.boss);
  ok("build: a boss was chosen", !!boss, boss ? "#" + boss.n : "none");
  ok("build: PRs excluded from trucks (pull_request filter works)", L90.obstacles.every(o => o.kind === "truck") && L90.counts.total < (c90.issues + 40), `trucks=${L90.counts.total} issues=${c90.issues}`);

  // --- failure paths (magic repos) ---
  let threw500 = false;
  try { await checkRepo("mock/error-500", "t"); } catch (e) { threw500 = /\b500\b/.test(e.message); }
  ok("mock/error-500 surfaces the 500", threw500);

  let rl = false;
  try { await buildLevelFromGitHub("mock/rate-limit", { branch: "main", token: "t", ...win(365) }); }
  catch (e) { rl = e instanceof RateLimitError; }
  ok("mock/rate-limit -> RateLimitError mid-fetch", rl);
} catch (e) {
  fail++; console.log("  ✗ threw: " + (e && e.stack || e));
}

await mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
