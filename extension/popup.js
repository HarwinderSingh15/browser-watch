(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    host = tab && tab.url ? new URL(tab.url).host : "";
  } catch {}
  const $ = (id) => document.getElementById(id);
  $("host").textContent = host || "(no site)";

  const load = () => chrome.storage.local.get(["allSites", "hosts", "excluded", "fields", "ignore", "port"]);

  // Sites that often show private information. They are still watched if the
  // user chose so; the popup only warns and points to "Stop watching".
  const SENSITIVE_SITE =
    /(^|\.)(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|mail\.proton\.me|icloud\.com|paypal\.com|stripe\.com|wise\.com|revolut\.com|accounts\.google\.com|myaccount\.google\.com|1password\.com|bitwarden\.com|lastpass\.com|web\.whatsapp\.com|linkedin\.com)$|bank|hrms|payroll|wallet|crypto|tax|insurance|health|medical|login|signin|auth/i;
  const flip = (list, item) => (list.includes(item) ? list.filter((h) => h !== item) : [...list, item]);

  async function render() {
    const { allSites = false, hosts = [], excluded = [], fields = [], ignore = {} } = await load();
    const watched = allSites ? !excluded.includes(host) : hosts.includes(host);
    $("allWarn").hidden = !allSites;
    $("sensitiveWarn").hidden = !(host && watched && SENSITIVE_SITE.test(host));
    $("all").checked = allSites;
    $("state").textContent = host ? (watched ? "— watched" : "— not watched") : "";
    $("toggle").textContent = watched ? "Stop watching this site" : "Watch this site";
    $("toggle").disabled = !host;
    $("fields").checked = fields.includes(host);
    $("fields").disabled = !host;
    if (document.activeElement !== $("ignore")) $("ignore").value = (ignore[host] || []).join("\n");
    const shown = allSites ? [...excluded] : [...hosts];
    $("listLabel").textContent = allSites ? "Excluded sites:" : "Watched sites:";
    $("list").innerHTML = "";
    if (!shown.length) shown.push("(none)");
    for (const h of shown) {
      const li = document.createElement("li");
      li.textContent = h;
      $("list").appendChild(li);
    }
  }

  $("all").onchange = async (e) => {
    await chrome.storage.local.set({ allSites: e.target.checked });
    render();
  };

  // In "every site" mode the button edits the exclude list; otherwise the watch list.
  $("toggle").onclick = async () => {
    const { allSites = false, hosts = [], excluded = [] } = await load();
    await chrome.storage.local.set(allSites ? { excluded: flip(excluded, host) } : { hosts: flip(hosts, host) });
    render();
  };

  $("fields").onchange = async () => {
    const { fields = [] } = await load();
    await chrome.storage.local.set({ fields: flip(fields, host) });
    render();
  };

  $("saveIgnore").onclick = async () => {
    const { ignore = {} } = await load();
    const lines = $("ignore").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const bad = lines.filter((l) => {
      try {
        new RegExp(l);
        return false;
      } catch {
        return true;
      }
    });
    if (bad.length) {
      $("saved").textContent = `Not a valid pattern: ${bad[0]}`;
      return;
    }
    if (lines.length) ignore[host] = lines;
    else delete ignore[host];
    await chrome.storage.local.set({ ignore });
    $("saved").textContent = "Saved ✓";
  };

  async function checkServer() {
    const { port = 7878 } = await load();
    $("port").value = port;
    $("status").textContent = "checking…";
    fetch(`http://127.0.0.1:${port}/health`)
      .then((r) => {
        if (!r.ok) throw new Error();
        $("status").textContent = `running on port ${port} ✓`;
      })
      .catch(() => ($("status").textContent = `not running on port ${port} — run ./install.sh (or node server.js)`));
  }

  $("savePort").onclick = async () => {
    const port = Number($("port").value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      $("status").textContent = "Port must be a number from 1 to 65535";
      return;
    }
    await chrome.storage.local.set({ port });
    checkServer();
  };

  checkServer();

  render();
})();
