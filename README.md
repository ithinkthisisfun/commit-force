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

## Run locally

```
node server.mjs      # then open http://localhost:8787/
```
Or serve the folder with any static server. (ES modules need `http://`, not `file://`.)

## Auth / rate limits

- **Public repos work with no login** (GitHub allows ~60 requests/hr per IP).
- For **private repos** or a higher limit (5,000/hr), paste a GitHub token — it's kept
  **only in your browser** (localStorage) and sent **only to github.com**.

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
