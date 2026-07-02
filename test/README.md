# Commit Force -- offline test harness

**Dev-only. Not part of the deployed game** (the served site blocks `/games/commit-force/test/*`,
and the deploy workflow strips this folder before upload).

Testing the fetch layer against real GitHub is painful: rate limits, and behaviour that only shows
up on huge repos. This harness removes that dependency with a **mock GitHub API** seeded with a large,
deterministic dataset, so the browser fetch layer can be exercised with no network and no rate limits.

## Files

- **`mock-github.mjs`** -- a zero-dependency Node HTTP server. Seeded (via a fixed PRNG, so it's
  identical every run) with ~4000 issues / 2000 PRs / 6000 commits spread across ~2 years. It mirrors
  only the endpoints the app hits, and faithfully reproduces the fragile bits: `per_page` pagination
  with a `Link` header (both `page`-based **and** cursor `after`-based, with all query params
  preserved), `since`/`until` windowing, search `total_count`, the `X-RateLimit-*` budget headers on
  every response, and the CORS headers a browser build needs to read them.
- **`run-tests.mjs`** -- starts the mock, points the real fetch layer at it (via `globalThis.__GH_API`),
  and asserts the behaviour we can't check live: counts grow with the date range, pagination assembles
  the *full* set, PRs are filtered out of trucks, the span equals the picked window, the boss is chosen,
  and the magic repos fail the way real GitHub would.

## Run the JS tests

```
cd games/commit-force
node test/run-tests.mjs
```

19 assertions; exits non-zero on any failure. This is the fast, no-setup check -- run it after any
change to `gitboy-github.js` or `gitboy-core.js`.

## Magic repos (failure modes)

Special repo names force behaviours at the mock, so the app's error/edge handling can be tested
without waiting for a real outage, rate lock, or a repo big enough to trip cursor pagination:

| repo | behaviour | what it tests |
| --- | --- | --- |
| `mock/error-500` | every endpoint returns HTTP 500 | generic-error surfacing (the message reaches the UI) |
| `mock/rate-limit` | page 1 of any list is served, then a 403 `x-ratelimit-remaining: 0` | hitting the cap *mid-fetch* -> `RateLimitError` -> "try again in ~N min" |
| `mock/nopage` | **422** on any `page=` param; hands back cursor (`after`) `Link` links instead | the fix for GitHub's real "page-based paging not supported for large datasets" 422 -- the client must follow the `rel="next"` cursor |

There's also a global budget knob: **`MOCK_RATE_LIMIT=N`** (env var, default 5000) makes the mock
return the 403 after `N` total requests across the run, regardless of repo. `0` = unlimited. Use it to
test what a browser build does when the whole run runs out of budget:

```
MOCK_RATE_LIMIT=50 node test/mock-github.mjs
```

## Full end-to-end in the browser

Serve the game folder and open it with `?api=` pointing at the mock:

```
node test/mock-github.mjs                       # terminal 1  -> http://localhost:8765 (override with PORT=…)
python -m http.server 5500                       # terminal 2, from games/commit-force/
# then browse to:
http://localhost:5500/?api=http://localhost:8765
```

Now "GO" hits the mock instead of GitHub -- real pagination, real size gate, real rate-limit warning.
Both localhost-only features are live here: the `?api=` override **and** the `GITHUB TOKEN` field
(the mock ignores the token, so paste anything to exercise the authenticated code path). The seed's
"today" is fixed at **2026-07-01**, so pick ranges ending on/before that; any `owner/name` works.

Both `?api=` and the token field are **guarded to localhost** in `index.html`, so the same query
string / a token can never affect the live site.

## The one production seam

`gitboy-github.js` reads its base URL as `globalThis.__GH_API || "https://api.github.com"`. In
production `__GH_API` is only ever set by the localhost-guarded `?api=` snippet in `index.html`
(inert on the deployed site), so it defaults to real GitHub. The tests set it directly before
importing the module. That's the only production-file touch.
