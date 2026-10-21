#!/bin/bash
# Removes what install.sh set up. Saved page text is kept unless you pass --delete-data.
set -uo pipefail

LABEL="com.browserwatch.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "✓ Server stopped"
rm -f "$PLIST" && echo "✓ Auto-start removed"

if [ -L "$HOME/.claude/skills/browser" ]; then
  rm "$HOME/.claude/skills/browser" && echo "✓ /browser skill removed"
fi

if command -v node >/dev/null; then
  node - <<'EOF'
const fs = require("fs"), os = require("os"), path = require("path");
const file = path.join(os.homedir(), ".claude", "settings.json");
const rule = "Read(~/.browser-watch/**)";
try {
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = s.permissions?.allow;
  if (list?.includes(rule)) {
    s.permissions.allow = list.filter((r) => r !== rule);
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    console.log("✓ Read permission removed from ~/.claude/settings.json");
  }
} catch {}
EOF
fi

if [ "${1:-}" = "--delete-data" ]; then
  rm -rf "$HOME/.browser-watch" && echo "✓ Deleted ~/.browser-watch"
else
  echo "Saved page text is still in ~/.browser-watch (run with --delete-data to remove it)."
fi
echo "Finally, remove the extension in brave://extensions (or chrome://extensions)."
