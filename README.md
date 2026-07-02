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
| `server.mjs` | local dev server; also hands your `gh` token to the browser for 5000/hr (local only) |
| `local-token.example.js` | template → copy to `local-token.js` to fetch with your own token |

## Run locally for 5000/hr

The whole thing is static — clone it and serve the folder over HTTP. (ES modules don't
load over `file://`, so you do need a server.) The bundled `server.mjs` is the easy path
because it *also* gives you 5000/hr for free if you have the GitHub CLI:

```bash
git clone https://github.com/ithinkthisisfun/commit-force
cd commit-force
gh auth login          # optional, once — for 5000/hr instead of anonymous 60/hr
node server.mjs        # -> http://localhost:8787/   (needs Node v18+)
```

Then open the URL, type a repo (e.g. `sveltejs/svelte`), pick a branch, and hit **GO**. All the
fetching happens in **your browser** against `api.github.com`; the server only hands over the files.
If you ran `gh auth login`, `server.mjs` reads your `gh auth token` and serves it to the browser as
`local-token.js` — so every fetch uses your **5000/hr** limit (and can read private repos), with no
PAT to create. The token is served only over `127.0.0.1`, never written to disk, and never deployed.

**No `gh` (or a different static server)?** Drop a [read-only token](https://github.com/settings/tokens)
into a local-only file instead:

```bash
cp local-token.example.js local-token.js
# then edit local-token.js:   window.__GH_TOKEN = "ghp_your_token_here";
```

Either way, `local-token.js` is **gitignored and stripped from the deploy**, and there is deliberately
no token *field* on the page — nothing to leak, and nothing that could be accidentally enabled in
production.

## Rate limits

The **hosted** site is intentionally tokenless — a public page shouldn't ask you to trust it
with a credential — so it runs at GitHub's anonymous **~60 requests/hour per IP** (enough for
a few builds; if you hit it, wait a few minutes). There is no token field or input anywhere in
the app — the only way to authenticate is a local-only `local-token.js` that is never deployed.
Want more? [Run it locally](#run-locally-for-5000hr) and drop in your own token — same code, your
machine, your credential.

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
