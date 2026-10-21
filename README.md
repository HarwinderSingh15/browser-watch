# browser-watch

Lets a Claude Code session in your terminal see the page you're looking at in your browser: the full text of the current page, plus live events for new lines (such as chat messages), tab switches and title changes.

```
Chrome extension ──POST──▶ server.js (127.0.0.1:7878) ──▶ ~/.browser-watch/current-page.md   (full text of the visible tab)
                                                       ├─▶ ~/.browser-watch/pages/<host>.md   (latest snapshot per site)
                                                       └─▶ ~/.browser-watch/events.jsonl      (navigations, new lines, tab/title changes)
                                                                      │
                                     Claude Code ◀── Monitor (live) ──┤
                                                 ◀── UserPromptSubmit hook (current page + new events on each prompt)
```

Nothing leaves your machine. The server only listens on `127.0.0.1` and only accepts data from the extension.

## Setup (macOS)

1. Install [Node.js](https://nodejs.org), then in this folder run:
   ```
   ./install.sh
   ```
   This starts the server now and at every login, installs the `/browser` skill for Claude Code, and lets Claude Code read `~/.browser-watch` without asking each time. You can run it again at any time, for example after `git pull` or moving the folder.
2. **Load the extension**: open `brave://extensions` (or `chrome://extensions`), turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
3. **Pick what to watch**: click the extension icon and either open a site and choose **Watch this site**, or tick **Watch every site**. Tabs that were already open start being watched right away. If one doesn't, reload it once.

To remove everything, run `./uninstall.sh` (add `--delete-data` to also delete saved page text), then remove the extension.

On Windows or Linux, run `node server.js` yourself, and copy `skill/browser` to `~/.claude/skills/browser`.

## Privacy

- **Watch every site** saves the text of every site you open, including email, chat, HR and admin panels. The popup shows a warning on sites that often hold private information (email, banking, payments, HR, password managers). Click **Stop watching this site** on any site you don't want captured.
- Password, card, token and one-time-code fields are never captured. Other text boxes are captured only on sites where you turn that on.
- Saved text is deleted after 7 days.
- Page text is written by whoever made the page or sent the message, so a page could contain instructions meant to trick Claude. The `/browser` skill and the prompt hook tell Claude to treat page text as data, never as instructions. Still, check what Claude proposes before letting it act on something it read in the browser.

## Using it from Claude Code

**Live (Claude reacts as messages arrive).** Tell Claude in the session:

> Monitor my browser: `tail -n0 -F ~/.browser-watch/events.jsonl`

Claude Code's Monitor tool wakes the session for each new line, so Claude sees new client messages while it works.

**Catch-up on every prompt (optional).** Add this to `.claude/settings.json` in a project, or to `~/.claude/settings.json` for every project:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/browser-watch/hooks/inject-unread.js" }] }
    ]
  }
}
```

Each time you send a prompt, the hook adds the current page's full text (if it changed, up to 30,000 characters) and any browser events since your last prompt to Claude's context.

**On demand.** Claude can also just read `~/.browser-watch/current-page.md` at any time.

## Notes

- The page text is the browser's `innerText` of the page: what's visible, with table rows as lines and cells separated by tabs. Hidden elements are not included.
- **Text boxes**: tick "Include text boxes on this site" in the popup to add text field and text area values under `## Form fields`. Password, card, token and one-time-code fields are always skipped.
- **Noise filter**: under "Ignore lines on this site" in the popup, add one regular expression per line; matching lines are left out of snapshots and change events. Google Chat and Gmail have built-in defaults (presence status, "Open in a pop-up", etc.).
- **History**: earlier versions of pages are kept in `~/.browser-watch/history/<host>/` — the final state of every page you leave, plus at most one version a minute while a page keeps changing.
- **Cleanup**: snapshots, history and events older than 7 days are deleted (at server start and hourly). Change with `BROWSER_WATCH_KEEP_DAYS`.
- Snapshots are taken at most once a second while the page changes, and when you switch to the tab. "New" lines are lines that weren't in the previous snapshot; for 3 seconds after navigation they aren't reported, so the page can finish loading.
- After updating the extension, click its reload button in `brave://extensions`.
- **Port**: if 7878 is taken, run `BROWSER_WATCH_PORT=7879 ./install.sh` and set the same port in the popup under **Server port**.
- **Only your copy of the extension**: the server accepts any Chrome extension by default; web pages are always refused. To allow only yours, copy its ID from `brave://extensions` and run `BROWSER_WATCH_EXTENSION_ID=<id> ./install.sh`.
- **Server problems**: the log is `~/.browser-watch/server.log`. Restart with `launchctl kickstart -k gui/$(id -u)/com.browserwatch.server`. If you upgrade or switch Node versions (for example with nvm), run `./install.sh` again so it uses the new `node`.
- To reset the log, delete `~/.browser-watch/events.jsonl` and `~/.browser-watch/hook-offset`.
# browser-watch
