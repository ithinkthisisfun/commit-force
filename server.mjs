#!/usr/bin/env node
// GITBOY static file server. That's all it does now -- it serves files.
// The browser talks to GitHub directly (see gitboy-github.mjs); no token, repo
// data, or GitHub traffic ever passes through here.
//
//   node server.mjs        then open http://localhost:8787/
// (Any static host works too -- GitHub Pages, Netlify, etc. This is just for local.)

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/" ) rel = "/index.html";
  const file = path.normalize(path.join(DIR, rel));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end("nope"); }   // no path traversal
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
server.listen(PORT, () => console.log(`\n  GITBOY  ->  http://localhost:${PORT}/   (static; browser fetches GitHub directly)\n`));
