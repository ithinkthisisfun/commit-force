# Commit Force -- offline test harness

**Dev-only. Not part of the deployed game** (the served site blocks `/games/commit-force/test/*`).

Testing against real GitHub is painful: the app is unauthenticated (60 requests/hr) and there's no
PAT by design. This harness removes that dependency with a **mock GitHub API** seeded with a large,
deterministic dataset, so the fetch layer, the loader scripts, *and* the browser build can be
exercised with no token, no network, and no rate limits.

## Files

- **`mock-github.mjs`** -- a zero-dependency Node HTTP server. Seeded (via a fixed PRNG, so it's
  identical every run) with ~4000 issues / 2000 PRs / 6000 commits spread across ~2 years. It mirrors
  only the endpoints the app + scripts hit, and faithfully reproduces the fragile bits:
  `per_page`/`page` pagination with `Link: rel="next"/"last"`, `since`/`until` windowing, search
  `total_count`, the `X-RateLimit-*` budget headers on every response, and the CORS headers
  (`Access-Control-Allow-Origin`, `Access-Control-Expose-Headers`) a browser build needs to read them.
- **`run-tests.mjs`** -- starts the mock, points the real fetch layer at it (via `globalThis.__GH_API`),
  and asserts the behaviour we can't check live: counts grow with the date range, pagination
  assembles the *full* set (no truncation past the soft caps), the Link-header commit count matches
  the fetch, PRs are filtered out of trucks, the span equals the picked window, the boss is chosen,
  and the two magic repos fail the way real GitHub would.

## Run the JS tests

```
cd games/commit-force
node test/run-tests.mjs
```

17 assertions; exits non-zero on any failure. This is the fast, no-setup check -- run it after any
change to `gitboy-github.js` or `gitboy-core.js`.

## Magic repos (failure modes)

Two repo names force failures at the mock, so the app's error handling can be tested without waiting
for a real outage or rate lock:

| repo | behaviour | what it tests |
| --- | --- | --- |
| `mock/error-500` | every endpoint returns HTTP 500 | generic-error surfacing (the message reaches the UI) |
| `mock/rate-limit` | page 1 of any list is served, then a 403 `x-ratelimit-remaining: 0` | hitting the cap *mid-fetch* -> `RateLimitError` -> "rate limit hit" message |

There's also a global budget knob: **`MOCK_RATE_LIMIT=N`** (env var, default 5000) makes the mock
return the same 403 after `N` total requests across the run, regardless of repo. `0` = unlimited.
Use it to test what a browser build does when the *whole run* runs out of budget:

```
MOCK_RATE_LIMIT=50 node test/mock-github.mjs
```

Examples against the magic repos:

```powershell
# PowerShell fetcher -- forced 500
$env:GH_API = "http://localhost:8765"; $env:GITHUB_TOKEN = "anything"
../loader-scripts/commit-force-fetch.ps1 mock/error-500
```
```bash
# bash fetcher -- rate lock mid-fetch (page 2+ of any list 403s)
GH_API=http://localhost:8765 GITHUB_TOKEN=anything ../loader-scripts/commit-force-fetch.sh mock/rate-limit
```

## Run the mock standalone (shell scripts / browser)

```
node test/mock-github.mjs            # serves http://localhost:8765 (override with PORT=…)
```

The seed's "today" is fixed at **2026-07-01**, so pick ranges ending on/before that. Any normal repo
name works (`owner/name`); the mock ignores the token and returns the same seeded data for all of them.

### Point the loader scripts at it

```powershell
# PowerShell fetcher
$env:GH_API = "http://localhost:8765"; $env:GITHUB_TOKEN = "anything"
../loader-scripts/commit-force-fetch.ps1 acme/widgets -Start 2026-04-01 -End 2026-07-01
```
```bash
# bash fetcher
GH_API=http://localhost:8765 GITHUB_TOKEN=anything ../loader-scripts/commit-force-fetch.sh acme/widgets 2026-04-01 2026-07-01
```

Each writes a `…-commit-force.json` bundle you can Load in the game.

### Point the browser build at it (full end-to-end)

Serve the game folder and open it with `?api=` pointing at the mock:

```
node test/mock-github.mjs                       # terminal 1
python -m http.server 5500                       # terminal 2, from games/commit-force/
# then browse to:
http://localhost:5500/?api=http://localhost:8765
```

Now "GO" hits the mock instead of GitHub -- real pagination, real size gate, real rate-limit
warning, no token. The `?api=` override is **guarded to localhost** in `index.html`, so the same
query string on the live site is inert and can never redirect a visitor's GitHub calls.

## The one production seam

`gitboy-github.js` reads its base URL as `globalThis.__GH_API || "https://api.github.com"`. In
production `__GH_API` is only ever set by the localhost-guarded `?api=` snippet in `index.html`
(inert on the deployed site), so it defaults to real GitHub. The tests set it directly before
importing the module. That's the only production-file touch.
