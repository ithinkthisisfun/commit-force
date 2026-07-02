# Commit Force

A 16-bit side-scroller that plays a **GitHub repo's history** as a level. Type a repo and a
team of little red meat-boys runs its issue/PR/commit log as a gauntlet — battling
issue-trucks, flinging commit-stars, dodging PR airplanes — compressed into ~a minute.

**Fully static. No backend.** The browser talks to `api.github.com` directly; nothing
(no repo, no token) ever touches a server.

## Files

| File | What it is |
|------|------------|
| `index.html` | the title / loader screen (entry point) |
| `play.html` | the game |
| `gitboy-core.js` | the pure data → level transform (shared) |
| `gitboy-github.js` | browser → GitHub fetch layer |
| `build-level.mjs` | optional local `gh` CLI path (`node build-level.mjs owner/repo`) |
| `server.mjs` | optional local static file server for previewing |

## Run locally for 5000/hr

The whole thing is static — clone it and serve the folder over HTTP. (ES modules don't
load over `file://`, so you do need a server; any static server works.)

```bash
git clone https://github.com/ithinkthisisfun/commit-force
cd commit-force

# option A — the bundled zero-dependency Node server
node server.mjs                 # -> http://localhost:8787/

# option B — any static server you already have
python3 -m http.server 8787     # -> http://localhost:8787/
npx serve .                     # -> http://localhost:3000/
```

Then open the URL, type a repo (e.g. `sveltejs/svelte`), pick a branch, and hit **GO**.
All the fetching happens in your browser against `api.github.com`; the local server only
hands over the HTML/JS. (`server.mjs` needs a reasonably recent Node — v18+.)

**When you run it on `localhost`, a `GITHUB TOKEN` field appears.** Paste a
[read-only Personal Access Token](https://github.com/settings/tokens) (fine-grained:
`Contents` = Read; classic: `repo` for private repos, no scopes for public) and every fetch
uses GitHub's **5000/hr** limit instead of the anonymous 60/hr — big/busy repos in one shot,
and private repos too. The token lives only in that browser tab and only ever goes to
`api.github.com`; it is never persisted or sent anywhere else.

## Rate limits

The **hosted** site is intentionally tokenless — a public page shouldn't ask you to trust it
with a credential — so it runs at GitHub's anonymous **~60 requests/hour per IP** (enough for
a few builds; if you hit it, wait a few minutes). The token field literally does not exist
off `localhost`. Want more? [Run it locally](#run-locally-for-5000hr) and paste your own
token — same code, your machine, your credential.

## Optional: pre-bake a level with the `gh` CLI

`build-level.mjs` fetches a repo through the **authenticated GitHub CLI** (much higher
limits, and private repos work) and writes a `level-data.js` that sets
`window.GITBOY_LEVEL`:

```bash
gh auth login                                       # once
node build-level.mjs sveltejs/svelte --commits 400 --out level-data.js
```

To play that pre-baked level instead of using the loader, add
`<script src="level-data.js"></script>` just before the game script in `play.html`, then
open `play.html` directly.

## How a repo maps to the game

| Repo thing | In the game |
|------------|-------------|
| Closed issue | a truck the crew battles until it **explodes** (resolved) |
| Open issue (worked on) | a truck battled, then **hopped off** — still open |
| Open issue (untouched) | a truck that just **rolls past** |
| Commit | a **star** flung off the runners (bot commits become **drones**) |
| Pull request | an **airplane** that fires a missile, then peels off (merged) or explodes (rejected) |
| Release / tag | a **checkpoint flag** that raises + chimes |
| Most-discussed issue | the **boss** (a long armored semi, slow-mo fight) |
| The finish | a final vault the crew crack open → **LEVEL COMPLETE** |

Issue trucks are split to the repo's **true open/closed ratio**, appear when the issue
opened, and their battle length tracks its open→close lifetime. New contributors get a
"…joined" note as the timeline reaches their first commit/PR/issue.

## Deploy

Any static host. On **Azure Static Web Apps**: point the app at this repo, no build step;
the `staticwebapp.config.json` (repo root) sets JS mime types.
