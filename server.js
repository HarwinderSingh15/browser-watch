#!/usr/bin/env node
// browser-watch server: receives events from the Chrome extension.
// - Full page snapshots go to ~/.browser-watch/current-page.md (the tab you're
//   looking at) and ~/.browser-watch/pages/<host>.md (latest per site).
// - Older versions of each page are kept in ~/.browser-watch/history/<host>/.
// - Navigation, tab, title and change events are appended to
//   ~/.browser-watch/events.jsonl and printed one line each on stdout.
// - Anything older than BROWSER_WATCH_KEEP_DAYS (default 7) is deleted.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.BROWSER_WATCH_PORT || 7878);
const KEEP_DAYS = Number(process.env.BROWSER_WATCH_KEEP_DAYS || 7);
const HISTORY_EVERY_MS = 60_000; // at most one saved version per site per minute while a page changes
const MAX_VERSIONS_PER_SITE = 500;

const DIR = path.join(os.homedir(), ".browser-watch");
const LOG = path.join(DIR, "events.jsonl");
const CURRENT = path.join(DIR, "current-page.md");
const PAGES = path.join(DIR, "pages");
const HISTORY = path.join(DIR, "history");
const HOOK_OFFSET = path.join(DIR, "hook-offset");
// Page text is private: only your user account may read it (folders 700, files 600).
process.umask(0o077);
fs.mkdirSync(PAGES, { recursive: true, mode: 0o700 });
fs.mkdirSync(HISTORY, { recursive: true, mode: 0o700 });
(function lockDown(p) {
  try {
    const st = fs.statSync(p);
    fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) lockDown(path.join(p, n));
  } catch {}
})(DIR);

const safeHost = (h) => String(h || "unknown").replace(/[^\w.-]/g, "_");
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

function writeAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const pageDoc = (e) => `# ${e.title}\n\nURL: ${e.url}\nCaptured: ${e.ts}\n\n---\n\n${e.text}\n`;

// --- History ---------------------------------------------------------------
// Per site: the latest snapshot waits as "pending". It is written to history
// when you leave that URL (so each page's final state is kept), or once a
// minute while the page keeps changing. Identical versions are skipped.
const historyState = new Map(); // host -> { pending, timer, lastHash }

function flushHistory(host) {
  const st = historyState.get(host);
  if (!st || !st.pending) return;
  clearTimeout(st.timer);
  st.timer = null;
  const e = st.pending;
  st.pending = null;
  if (!e.text || e.text.length < 20) return; // still loading
  const hash = sha1(e.url + "\n" + e.text);
  if (hash === st.lastHash) return;
  st.lastHash = hash;
  const dir = path.join(HISTORY, safeHost(host));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, e.ts.replace(/[:.]/g, "-") + ".md"), pageDoc(e));
}

function recordHistory(e) {
  let st = historyState.get(e.host);
  if (!st) historyState.set(e.host, (st = { pending: null, timer: null, lastHash: "" }));
  if (st.pending && st.pending.url !== e.url) flushHistory(e.host); // left a page: keep its final state
  st.pending = e;
  if (!st.timer) st.timer = setTimeout(() => flushHistory(e.host), HISTORY_EVERY_MS);
}

// --- Cleanup ---------------------------------------------------------------
function rmOlderThan(dir, cutoffMs) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      rmOlderThan(p, cutoffMs);
      const left = fs.readdirSync(p).sort();
      for (const f of left.slice(0, Math.max(0, left.length - MAX_VERSIONS_PER_SITE))) fs.unlinkSync(path.join(p, f));
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    } else if (st.mtimeMs < cutoffMs) {
      fs.unlinkSync(p);
    }
  }
}

function trimLog(cutoffIso) {
  if (!fs.existsSync(LOG)) return;
  const buf = fs.readFileSync(LOG);
  let pos = 0;
  // Lines are in time order: skip the old ones at the start.
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const end = nl === -1 ? buf.length : nl + 1;
    let ts = "";
    try {
      ts = JSON.parse(buf.subarray(pos, end).toString("utf8")).ts || "";
    } catch {}
    if (ts >= cutoffIso) break;
    pos = end;
  }
  if (pos === 0) return;
  writeAtomic(LOG, buf.subarray(pos));
  // Keep the prompt hook's read position pointing at the same event.
  try {
    const off = Number(fs.readFileSync(HOOK_OFFSET, "utf8")) || 0;
    fs.writeFileSync(HOOK_OFFSET, String(Math.max(0, off - pos)));
  } catch {}
  console.error(`cleanup: removed ${pos} bytes of events older than ${KEEP_DAYS} days`);
}

function cleanup() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  try {
    rmOlderThan(HISTORY, cutoff);
    rmOlderThan(PAGES, cutoff);
    trimLog(new Date(cutoff).toISOString());
  } catch (err) {
    console.error("cleanup failed:", err.message);
  }
}

// --- Events ----------------------------------------------------------------
function summarize(e) {
  const where = e.title ? `${e.host} — ${e.title}` : e.host;
  switch (e.type) {
    case "page":
      return `[${where}] OPENED: ${e.url}`;
    case "change":
      return `[${where}] NEW: ${e.added.join(" | ")}${e.more ? ` (+${e.more} more lines)` : ""}`;
    case "tab":
      return `[${where}] SWITCHED TO: ${e.url}`;
    case "title":
      return `[${where}] TITLE CHANGED`;
    default:
      return `[${where}] ${e.type}`;
  }
}

function log(e) {
  fs.appendFileSync(LOG, JSON.stringify(e) + "\n");
  console.log(`${e.ts.slice(11, 19)} ${summarize(e)}`);
}

function handle(e) {
  e.ts = e.ts || new Date().toISOString();
  if (e.type === "page") {
    const doc = pageDoc(e);
    writeAtomic(path.join(PAGES, safeHost(e.host) + ".md"), doc);
    if (e.visible) writeAtomic(CURRENT, doc);
    recordHistory(e);
    // Log navigations only, without the full text, to keep the log small.
    if (e.navigated) {
      const { text, ...rest } = e;
      log(rest);
    }
    return;
  }
  log(e);
}

// Only the extension may talk to the server. Web pages always send their own
// Origin (https://…), which a page cannot fake, so they are refused; otherwise
// any site could post invented "page text" for Claude to read. Requests with
// no Origin come from local programs (curl), which can write the files anyway.
// The Host check blocks DNS-rebinding tricks (evil.com resolving to 127.0.0.1).
// Set BROWSER_WATCH_EXTENSION_ID to accept only your own copy of the extension.
const EXTENSION_ID = process.env.BROWSER_WATCH_EXTENSION_ID || "";
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function allowed(req) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (EXTENSION_ID) return origin === `chrome-extension://${EXTENSION_ID}`;
  return origin.startsWith("chrome-extension://");
}

const server = http.createServer((req, res) => {
  if (!allowed(req)) {
    res.statusCode = 403;
    return res.end('{"ok":false,"error":"forbidden"}');
  }

  if (req.method === "GET" && req.url === "/health") {
    return res.end(JSON.stringify({ ok: true, log: LOG, currentPage: CURRENT, keepDays: KEEP_DAYS }));
  }

  if (req.method === "POST" && req.url === "/event") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5e6) req.destroy();
    });
    req.on("end", () => {
      try {
        for (const e of [].concat(JSON.parse(body))) handle(e);
        res.end('{"ok":true}');
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end();
});

// Save pending history on Ctrl+C so the last version of each page isn't lost.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const host of historyState.keys()) flushHistory(host);
    process.exit(0);
  });
}

cleanup();
setInterval(cleanup, 3_600_000);

// Bind to localhost only: page text never leaves the machine.
server.listen(PORT, "127.0.0.1", () => {
  console.error(`browser-watch listening on http://127.0.0.1:${PORT}`);
  console.error(`current page: ${CURRENT}`);
  console.error(`history:      ${HISTORY} (kept ${KEEP_DAYS} days)`);
  console.error(`event log:    ${LOG}`);
});
