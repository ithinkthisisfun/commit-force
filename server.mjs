#!/usr/bin/env node
// Commit Force -- local dev server (LOCAL ONLY; never deployed).
//
// Serves the static files, AND -- as a convenience -- hands your browser your `gh` CLI token so a
// locally-run copy fetches at GitHub's 5000/hr limit with no PAT to paste:
//
//   gh auth login          # once
//   node server.mjs        # then open http://localhost:8787/
//
// index.html already loads /local-token.js, so the server just answers that request: it prefers a real
// local-token.js file if you made one, otherwise it synthesizes one from `gh auth token`. The token is
// read fresh at startup, served ONLY over 127.0.0.1 (never on your LAN), and never written to disk or
// deployed. No `gh`? Skip it -- you run at the anonymous 60/hr, or create local-token.js by hand.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

// Read the gh CLI token once (empty if gh isn't installed / not logged in).
let ghToken = "";
try { ghToken = (await pexec("gh", ["auth", "token"])).stdout.trim(); } catch {}

function sendJs(res, body) { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); res.end(body); }

const server = http.createServer(async (req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";

  // /local-token.js -> prefer a real file (explicit PAT), else synthesize one from the gh token.
  if (rel === "/local-token.js") {
    try { return sendJs(res, await readFile(path.join(DIR, "local-token.js"))); } catch {}
    if (ghToken) return sendJs(res, `window.__GH_TOKEN=${JSON.stringify(ghToken)};\n`);
    res.writeHead(404); return res.end("// no local token");
  }

  const file = path.normalize(path.join(DIR, rel));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end("nope"); }   // no path traversal
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});

// 127.0.0.1 ONLY -- the injected gh token must never be reachable from the LAN.
server.listen(PORT, "127.0.0.1", () => console.log(
  `\n  Commit Force  ->  http://localhost:${PORT}/   ` +
  (ghToken ? "(gh token found -> 5000/hr)" : "(anonymous 60/hr; run `gh auth login` for 5000/hr)") + "\n"));
