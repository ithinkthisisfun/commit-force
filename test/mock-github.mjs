// Commit Force -- MOCK GitHub API for offline testing. DEV-ONLY; not part of the deployed game.
//
// A tiny zero-dependency HTTP server seeded (deterministically) with ~12k issues/PRs/commits spread
// across ~2 years. It mirrors only the endpoints the app + loader scripts hit, faithfully enough to
// exercise the fragile bits: per_page/page pagination with Link rel="next"/"last", `since`/`until`
// windowing, and search `total_count`. So the fetch layer and the shell scripts can be tested with
// no token, no network, and no rate limits.
//
// Run standalone:   node mock-github.mjs        (serves http://localhost:8765)
// Or import:        import { startMock } from "./mock-github.mjs"
import http from "node:http";

const DAY = 86400000;
const NOW = Date.parse("2026-07-01T00:00:00Z");   // fixed "today" so every run is reproducible
const SPAN = 730 * DAY;                            // seed activity across ~2 years
const N_ISSUES = 4000, N_PRS = 2000, N_COMMITS = 6000;
const RATE_LIMIT = +(process.env.MOCK_RATE_LIMIT || 5000);   // budget per server run; set low to test exhaustion (0 = unlimited)
let REQUESTS = 0;
const AUTHORS = Array.from({ length: 50 }, (_, i) => `dev${i}`);
const LABELS = ["bug", "enhancement", "feature", "documentation", "good first issue", "help wanted", "perf", "security", "regression", "question"];

// deterministic PRNG (mulberry32) -- no Math.random, so the dataset is identical every run
function mulberry32(a) { return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const iso = ms => new Date(ms).toISOString();
const clampNow = ms => Math.min(ms, NOW);

function buildSeed() {
  const rnd = mulberry32(20260701);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const mkIssueLike = (n, kind) => {                 // kind: "issue" | "pr"
    const created = NOW - Math.floor(rnd() * SPAN);
    const isClosed = rnd() < 0.6;
    const closedAt = isClosed ? clampNow(created + Math.floor(rnd() * 120 * DAY)) : null;
    const updated = clampNow(Math.max(created, closedAt || created) + Math.floor(rnd() * 20 * DAY));
    const r = {
      number: n,
      title: `${kind === "pr" ? "PR" : "Issue"} #${n}: ${pick(["fix", "add", "update", "drop", "refactor"])} ${pick(["parser", "ui", "docs", "api", "build", "tests"])}`,
      html_url: `https://github.com/acme/widgets/${kind === "pr" ? "pull" : "issues"}/${n}`,
      state: isClosed ? "closed" : "open",
      user: { login: pick(AUTHORS) },
      comments: Math.floor(rnd() * rnd() * 90),      // skewed low, occasional loud thread
      created_at: iso(created), updated_at: iso(updated), closed_at: closedAt ? iso(closedAt) : null,
    };
    if (kind === "issue") r.labels = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ name: pick(LABELS) }));
    if (kind === "pr") r.merged_at = isClosed && rnd() < 0.7 ? closedAt : null;
    return r;
  };
  const issues = Array.from({ length: N_ISSUES }, (_, i) => mkIssueLike(i + 1, "issue"));
  const prs = Array.from({ length: N_PRS }, (_, i) => mkIssueLike(N_ISSUES + i + 1, "pr"));
  const commits = Array.from({ length: N_COMMITS }, (_, i) => {
    const d = NOW - Math.floor(rnd() * SPAN);
    return { sha: (i + 1).toString(16).padStart(40, "0"), author: { login: pick(AUTHORS) },
      commit: { author: { date: iso(d), name: pick(AUTHORS) }, committer: { date: iso(d) }, message: `${pick(["fix", "feat", "chore", "docs"])}: ${pick(["parser", "ui", "api"])} tweak\n\nbody` } };
  });
  const releases = Array.from({ length: 12 }, (_, i) => ({ tag_name: `v1.${i}.0`, name: `Release 1.${i}`, prerelease: i % 4 === 0, published_at: iso(NOW - i * 30 * DAY) }));
  return { issues, prs, commits, releases };
}

const ms = s => Date.parse(s);
const byUpdatedDesc = (a, b) => ms(b.updated_at) - ms(a.updated_at);

function paginate(items, u) {
  const per = Math.min(100, Math.max(1, +(u.searchParams.get("per_page") || 30)));
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  // Link URLs preserve ALL original query params (since/until/sha/state/...), like real GitHub -- only
  // the paging cursor changes -- so follow-up pages stay windowed.
  const linkFor = over => { const q = new URLSearchParams(u.searchParams); q.set("per_page", String(per)); for (const k in over) q.set(k, String(over[k])); return `${base}?${q}`; };
  if (/^\/repos\/mock\/nopage\//.test(u.pathname)) {          // cursor-only mode (mimics GitHub's large-dataset pagination): no page numbers, just an `after` offset
    const after = Math.max(0, +(u.searchParams.get("after") || 0));
    const slice = items.slice(after, after + per);
    const link = (after + per < items.length) ? `<${linkFor({ after: after + per })}>; rel="next"` : "";
    return { slice, link };
  }
  const page = Math.max(1, +(u.searchParams.get("page") || 1));
  const total = items.length, last = Math.max(1, Math.ceil(total / per));
  const slice = items.slice((page - 1) * per, page * per);
  const mk = (p, rel) => `<${linkFor({ page: p })}>; rel="${rel}"`;
  const links = [];
  if (page < last) links.push(mk(page + 1, "next"));
  links.push(mk(last, "last"));
  if (page > 1) { links.push(mk(1, "first")); links.push(mk(page - 1, "prev")); }
  return { slice, link: links.join(", ") };
}

// Real GitHub returns the rate-limit budget on EVERY response; the mock does too, and it's exposed
// via CORS so a browser build pointed at the mock can read it.
function rateHeaders() {
  return { "X-RateLimit-Limit": String(RATE_LIMIT), "X-RateLimit-Remaining": String(Math.max(0, RATE_LIMIT - REQUESTS)),
    "X-RateLimit-Used": String(Math.min(REQUESTS, RATE_LIMIT)), "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
}
function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Link, ETag, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Reset",
    ...rateHeaders(), ...headers });
  res.end(JSON.stringify(body));
}
// the 403 GitHub returns when the bucket is empty (x-ratelimit-remaining: 0 + a reset the client waits on)
function sendRateLimit(res) {
  sendJSON(res, 403, { message: "API rate limit exceeded (mock)" },
    { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 600) });
}
// MAGIC REPOS (imitate failures for error-path tests):
//   mock/error-500  -> every endpoint 500s
//   mock/rate-limit -> page 1 of any list is fine, then it returns the rate-limit 403 (tests mid-fetch)
function magicFail(res, p, qp) {
  const m = p.match(/^\/repos\/([^/]+\/[^/]+)/);
  const repo = m ? m[1] : (p === "/search/issues" ? ((qp.get("q") || "").match(/repo:(\S+)/) || [])[1] : null);
  if (repo === "mock/error-500") { sendJSON(res, 500, { message: "mock: forced 500" }); return true; }
  if (repo === "mock/rate-limit" && /\/(issues|pulls|commits)$/.test(p) && +(qp.get("page") || 1) >= 2) { sendRateLimit(res); return true; }
  return false;
}

function handle(req, res, seed) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" }); return res.end(); }
  const p = u.pathname, qp = u.searchParams;
  REQUESTS++;                                        // every response carries the (decrementing) rate-limit budget
  if (RATE_LIMIT > 0 && REQUESTS > RATE_LIMIT) return sendRateLimit(res);   // budget exhausted -> real 403 (set MOCK_RATE_LIMIT low to test)
  if (magicFail(res, p, qp)) return;               // magic repos short-circuit with a forced failure
  if (/^\/repos\/mock\/nopage\//.test(p) && qp.has("page"))   // mock/nopage rejects page-based paging exactly like GitHub does on large datasets
    return sendJSON(res, 422, { message: "Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)" });

  if (p === "/user") return sendJSON(res, 200, { login: "mock-user", id: 1 });   // whoami preflight (the fetch scripts greet you by login)
  if (p === "/rate_limit") { const rem = RATE_LIMIT > 0 ? Math.max(0, RATE_LIMIT - REQUESTS) : 60;   // budget endpoint (friendly "N left, resets HH:MM")
    return sendJSON(res, 200, { rate: { limit: RATE_LIMIT || 60, remaining: rem, used: Math.min(REQUESTS, RATE_LIMIT || 60), reset: Math.floor(Date.now() / 1000) + 3600 } }); }

  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return sendJSON(res, 200, { default_branch: "main", private: false, full_name: p.slice(7) });
  if (/^\/repos\/[^/]+\/[^/]+\/branches$/.test(p)) { const { slice, link } = paginate([{ name: "main" }, { name: "develop" }, { name: "release" }], u); return sendJSON(res, 200, slice, { Link: link }); }

  if (/^\/repos\/[^/]+\/[^/]+\/issues$/.test(p)) {
    // GitHub's /issues returns PRs too (tagged with pull_request) -- include them so the client filter is exercised
    let items = [...seed.issues, ...seed.prs.map(pr => ({ ...pr, pull_request: { url: pr.html_url } }))].sort(byUpdatedDesc);
    const since = qp.get("since"); if (since) items = items.filter(x => ms(x.updated_at) >= ms(since));
    const { slice, link } = paginate(items, u); return sendJSON(res, 200, slice, { Link: link });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(p)) {
    const items = [...seed.prs].sort(byUpdatedDesc);
    const { slice, link } = paginate(items, u); return sendJSON(res, 200, slice, { Link: link });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/commits$/.test(p)) {
    let items = [...seed.commits].sort((a, b) => ms(b.commit.author.date) - ms(a.commit.author.date));
    const since = qp.get("since"), until = qp.get("until");
    if (since) items = items.filter(c => ms(c.commit.author.date) >= ms(since));
    if (until) items = items.filter(c => ms(c.commit.author.date) <= ms(until));
    const { slice, link } = paginate(items, u); return sendJSON(res, 200, slice, { Link: link });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(p)) { const { slice, link } = paginate(seed.releases, u); return sendJSON(res, 200, slice, { Link: link }); }

  if (p === "/search/issues") {
    const q = qp.get("q") || "";
    let set = /type:pr/.test(q) ? seed.prs : seed.issues;
    const m = q.match(/updated:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
    if (m) { const a = ms(m[1]), b = ms(m[2]) + DAY; set = set.filter(x => ms(x.updated_at) >= a && ms(x.updated_at) < b); }
    const { slice } = paginate(set, u);
    return sendJSON(res, 200, { total_count: set.length, incomplete_results: false, items: slice });
  }
  if (p === "/search/repositories") return sendJSON(res, 200, { total_count: 3, incomplete_results: false,
    items: [{ full_name: "acme/widgets", stargazers_count: 42000 }, { full_name: "acme/gadgets", stargazers_count: 12000 }, { full_name: "acme/gizmos", stargazers_count: 8000 }] });

  return sendJSON(res, 404, { message: "Not Found" });
}

export function startMock({ port = 0 } = {}) {
  const seed = buildSeed();
  const server = http.createServer((req, res) => handle(req, res, seed));
  return new Promise(resolve => server.listen(port, () => {
    const addr = server.address();
    resolve({ server, seed, url: `http://localhost:${addr.port}`, close: () => new Promise(r => server.close(r)) });
  }));
}

// standalone
const arg1 = (process.argv[1] || "").replace(/\\/g, "/");
if (arg1.endsWith("mock-github.mjs")) {
  startMock({ port: +(process.env.PORT || 8765) }).then(({ url, seed }) =>
    console.log(`mock GitHub at ${url}  (seeded ${seed.issues.length} issues, ${seed.prs.length} PRs, ${seed.commits.length} commits)`));
}
