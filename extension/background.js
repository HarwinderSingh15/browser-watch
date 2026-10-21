// Forwards events to the local server and reports tab/screen changes
// for watched sites only.
// The port can be changed in the popup (must match BROWSER_WATCH_PORT on the server).
async function serverUrl() {
  const { port = 7878 } = await chrome.storage.local.get("port");
  return `http://127.0.0.1:${port}/event`;
}

async function isWatched(host) {
  const { allSites = false, hosts = [], excluded = [] } = await chrome.storage.local.get(["allSites", "hosts", "excluded"]);
  return allSites ? !excluded.includes(host) : hosts.includes(host);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function send(events) {
  try {
    await fetch(await serverUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(events),
    });
  } catch {
    // Server not running; drop silently.
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.kind !== "events") return;
  // On macOS, Chrome marks a page "hidden" when its window is covered (e.g. by
  // the terminal), so use "is the selected tab in its window" instead.
  const active = !!(sender.tab && sender.tab.active);
  for (const e of msg.events) if (e.type === "page") e.visible = active;
  send(msg.events);
});

let lastScreen = "";
async function reportTab(tab) {
  if (!tab || !tab.url) return;
  const host = hostOf(tab.url);
  if (!host || !(await isWatched(host))) return;
  const key = tab.url + "|" + tab.title;
  if (key === lastScreen) return;
  lastScreen = key;
  send([{ type: "tab", host, url: tab.url, title: tab.title || "" }]);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  reportTab(await chrome.tabs.get(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.url || info.status === "complete")) reportTab(tab);
});

// Tabs that were open before the extension was installed or reloaded don't get
// the content script automatically, so add it to them now.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
});
