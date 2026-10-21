#!/bin/bash
# Installs browser-watch for the current macOS user:
#   1. runs server.js in the background now and at every login (launchd)
#   2. installs the /browser skill for Claude Code (linked, so `git pull` updates it)
#   3. lets Claude Code read ~/.browser-watch without asking each time
# Safe to run again (e.g. after `git pull` or moving the folder).
#
# Optional settings, passed through to the server:
#   BROWSER_WATCH_PORT=7878  BROWSER_WATCH_KEEP_DAYS=7  BROWSER_WATCH_EXTENSION_ID=<id from brave://extensions>
set -euo pipefail

LABEL="com.browserwatch.server"
REPO="$(cd "$(dirname "$0")" && pwd)"
DATA="$HOME/.browser-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SKILLS="$HOME/.claude/skills"
PORT="${BROWSER_WATCH_PORT:-7878}"

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS. On other systems run: node $REPO/server.js" >&2
  exit 1
fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js not found. Install it (https://nodejs.org) and run this again." >&2
  exit 1
fi

mkdir -p "$DATA" "$HOME/Library/LaunchAgents" "$SKILLS"

# --- 1. Background server ----------------------------------------------------
# Stop an old copy: our own launchd job, or a browser-watch server started by hand.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '\.browser-watch'; then
  for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  sleep 1
fi
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is used by another program. Pick another: BROWSER_WATCH_PORT=7879 ./install.sh" >&2
  echo "(then set the same port in the extension popup under 'Server port')" >&2
  exit 1
fi

env_entry() { [ -n "${2:-}" ] && printf '      <key>%s</key><string>%s</string>\n' "$1" "$2" || true; }
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE</string>
      <string>$REPO/server.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
$(env_entry BROWSER_WATCH_PORT "$PORT")
$(env_entry BROWSER_WATCH_KEEP_DAYS "${BROWSER_WATCH_KEEP_DAYS:-}")
$(env_entry BROWSER_WATCH_EXTENSION_ID "${BROWSER_WATCH_EXTENSION_ID:-}")
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$DATA/server.log</string>
    <key>StandardErrorPath</key><string>$DATA/server.log</string>
  </dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ -n "$ok" ]; then
  echo "✓ Server running on http://127.0.0.1:$PORT (starts automatically at login)"
else
  echo "✗ Server did not start. See $DATA/server.log" >&2
  exit 1
fi

# --- 2. Claude Code skill ----------------------------------------------------
TARGET="$SKILLS/browser"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  BACKUP="$SKILLS/browser.bak-$(date +%Y%m%d%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "  (moved your existing browser skill to $BACKUP)"
fi
ln -sfn "$REPO/skill/browser" "$TARGET"
echo "✓ Claude Code skill installed: /browser"

# --- 3. Read permission ------------------------------------------------------
"$NODE" - <<'EOF'
const fs = require("fs"), os = require("os"), path = require("path");
const file = path.join(os.homedir(), ".claude", "settings.json");
const rule = "Read(~/.browser-watch/**)";
let s = {};
if (fs.existsSync(file)) {
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { console.error(`! ${file} is not valid JSON; add "${rule}" to permissions.allow yourself.`); process.exit(0); }
}
s.permissions ??= {};
s.permissions.allow ??= [];
if (s.permissions.allow.includes(rule)) { console.log("✓ Claude Code can already read ~/.browser-watch"); process.exit(0); }
if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak-browserwatch");
s.permissions.allow.push(rule);
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
console.log("✓ Claude Code can read ~/.browser-watch without asking (backup: settings.json.bak-browserwatch)");
EOF

cat <<EOF

Last step, in Brave or Chrome:
  1. Open brave://extensions (or chrome://extensions) and turn on Developer mode.
  2. Click "Load unpacked" and pick: $REPO/extension
     (Already loaded? Click its reload button instead.)
  3. Click the extension icon and choose which sites to watch.
EOF
[ "$PORT" != "7878" ] && echo "  4. In the popup, open 'Server port' and set it to $PORT."
echo
echo "Then ask Claude Code: \"what's on my current browser page?\""
