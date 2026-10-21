// Sends a full text snapshot of the page (on watched sites, set in the
// popup) whenever it loads, changes, or becomes the visible tab. Also sends a
// "change" event listing the lines that were added since the last snapshot,
// so new chat messages show up as their own events.
(async () => {
  const host = location.host;
  const KEYS = ["allSites", "hosts", "excluded", "fields", "ignore"];

  // Lines that are UI noise on some sites. Users can add their own per site in the popup.
  const DEFAULT_IGNORE = {
    "chat.google.com": [
      "^(Active|Away|Idle|Do not disturb|Offline)$",
      "^(Open in a pop-up|Options|Space|Quoted|End Quote|Edited|,)$",
      "press L to link back to original quote",
    ],
    "mail.google.com": ["^(Starred|Not starred|Important|Not important|Select)$"],
  };

  let settings = await chrome.storage.local.get(KEYS);
  const isWatched = ({ allSites = false, hosts = [], excluded = [] }) =>
    allSites ? !excluded.includes(host) : hosts.includes(host);
  let active = isWatched(settings);
  let started = false;
  let resnapshot = null;

  // Settings changes apply right away, without reloading the tab.
  chrome.storage.onChanged.addListener(async () => {
    settings = await chrome.storage.local.get(KEYS);
    active = isWatched(settings);
    if (active && !started) start();
    else if (active && resnapshot) resnapshot();
  });
  if (active) start();

  function start() {
    started = true;

    const MAX_PAGE = 500_000; // characters
    const MAX_ADDED = 80; // lines per change event
    const THROTTLE_MS = 1000;
    const SETTLE_MS = 3000; // after navigation, let the page render before reporting changes

    let lastUrl = "";
    let lastText = "";
    let settledAt = 0;
    let timer = null;

    function send(events) {
      if (!active) return;
      try {
        chrome.runtime.sendMessage({ kind: "events", events });
      } catch {
        // Extension was reloaded; this old content script can't talk to it anymore.
      }
    }

    function ignorePatterns() {
      const list = [...(DEFAULT_IGNORE[host] || []), ...((settings.ignore || {})[host] || [])];
      const out = [];
      for (const p of list) {
        try {
          out.push(new RegExp(p, "i"));
        } catch {
          // Bad pattern typed in the popup; skip it.
        }
      }
      return out;
    }

    // --- Form fields (opt-in per site) -------------------------------------
    const SENSITIVE = /pass|pwd|card|cc-|cvv|cvc|csc|secret|token|otp|one-time|pin\b|ssn|iban|account.?number/i;
    const TEXT_TYPES = new Set(["", "text", "email", "url", "search", "tel", "number"]);

    function fieldLabel(el) {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ")
          .trim();
        if (t) return t;
      }
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && l.innerText.trim()) return l.innerText.trim();
      }
      const wrap = el.closest("label");
      if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
      return (el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "(unlabelled field)").trim();
    }

    function isSensitive(el) {
      if (el.type === "password" || el.type === "hidden") return true;
      const hints = [el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.getAttribute("placeholder")]
        .filter(Boolean)
        .join(" ");
      return SENSITIVE.test(hints);
    }

    function readFields() {
      const lines = [];
      for (const el of document.querySelectorAll("textarea, input")) {
        if (el.tagName === "INPUT" && !TEXT_TYPES.has((el.getAttribute("type") || "").toLowerCase())) continue;
        if (isSensitive(el) || !el.value || !el.value.trim()) continue;
        if (!el.getClientRects().length) continue; // not visible
        const label = fieldLabel(el).replace(/\s+/g, " ").slice(0, 120);
        const value = el.value.length > 20_000 ? el.value.slice(0, 20_000) + "…" : el.value;
        lines.push(`### ${label}\n${value}`);
      }
      return lines.length ? `\n\n---\n\n## Form fields\n\n${lines.join("\n\n")}` : "";
    }

    // innerText keeps the visible layout: table rows become lines, cells are tab-separated.
    // Hidden elements are not included; form field values only on sites where the user enabled them.
    function readPage() {
      const ignore = ignorePatterns();
      let t = (document.body ? document.body.innerText : "")
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .filter((l) => !ignore.some((re) => re.test(l.trim())))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if ((settings.fields || []).includes(host)) t += readFields();
      return t.length > MAX_PAGE ? t.slice(0, MAX_PAGE) + "\n…(page truncated)" : t;
    }

    // Lines in `after` that were not in `before`, counting duplicates.
    function addedLines(before, after) {
      const counts = new Map();
      for (const l of before.split("\n")) {
        const k = l.trim();
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      const added = [];
      for (const l of after.split("\n")) {
        const k = l.trim();
        if (!k) continue;
        const n = counts.get(k) || 0;
        if (n > 0) counts.set(k, n - 1);
        else added.push(k);
      }
      return added;
    }

    function snapshot(force) {
      timer = null;
      const url = location.href;
      const text = readPage();
      const navigated = url !== lastUrl;
      if (!navigated && !force && text === lastText) return;
      if (navigated) settledAt = Date.now() + SETTLE_MS;

      const base = { host, url, title: document.title };
      const events = [];
      if (!navigated && lastText && Date.now() >= settledAt) {
        const added = addedLines(lastText, text);
        if (added.length) {
          events.push({
            type: "change",
            ...base,
            added: added.slice(0, MAX_ADDED),
            more: Math.max(0, added.length - MAX_ADDED),
          });
        }
      }
      events.push({
        type: "page",
        ...base,
        visible: document.visibilityState === "visible",
        navigated,
        text,
      });
      lastUrl = url;
      lastText = text;
      send(events);
    }

    const schedule = () => {
      if (!timer) timer = setTimeout(() => snapshot(false), THROTTLE_MS);
    };
    resnapshot = schedule;

    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Typing in a field doesn't change the DOM, so listen for it when fields are captured.
    document.addEventListener(
      "input",
      () => {
        if ((settings.fields || []).includes(host)) schedule();
      },
      true,
    );

    // Switching to this tab makes it the "current page".
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") snapshot(true);
    });

    setTimeout(() => snapshot(true), 1000);
  }
})();
