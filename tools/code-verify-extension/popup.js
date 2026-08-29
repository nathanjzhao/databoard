/*
 * popup.js — render the verdict the content script produced for the active tab.
 */

const HEADLINES = {
  green: "Served JS matches the manifest",
  red: "Served JS does NOT match",
  unavailable: "No manifest to check",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function short(sha) {
  return sha ? `${sha.slice(0, 12)}…` : "unknown";
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const verdict = document.getElementById("verdict");
  const headline = document.getElementById("headline");
  const body = document.getElementById("body");
  body.replaceChildren();

  let result = null;
  if (tab && tab.id != null) {
    let store = {};
    try {
      store = await chrome.storage.session.get(`tab:${tab.id}`);
    } catch {
      store = await chrome.storage.local.get(`tab:${tab.id}`);
    }
    result = store[`tab:${tab.id}`] || null;
  }

  if (!result) {
    verdict.className = "verdict unavailable";
    headline.textContent = "Not a checked page";
    body.append(
      el(
        "div",
        "note",
        "Open getdataboard.vercel.app (or a localhost dev build) and reload. The check runs after the page finishes loading.",
      ),
    );
    return;
  }

  const status = result.status || "unavailable";
  verdict.className = `verdict ${status}`;
  headline.textContent = HEADLINES[status] || "Unknown";

  // Meta block.
  const meta = el("div", "meta");
  const rows = [
    ["origin", result.origin || "?"],
    ["commit", result.commit ? short(result.commit) : "unknown"],
    [
      "manifest",
      result.manifest
        ? `v${result.manifest.version}, ${result.manifest.file_count} files`
        : "unavailable",
    ],
    [
      "loaded",
      `${result.counts.executables} js · ${result.counts.styles} css · ${result.counts.inline} inline`,
    ],
    ["checked", (result.checkedAt || "").replace("T", " ").slice(0, 19)],
  ];
  for (const [k, v] of rows) {
    const row = el("div");
    row.append(el("span", null, k), el("span", "mono", v));
    meta.append(row);
  }
  body.append(meta);

  // Problems (red) first.
  if (result.problems && result.problems.length) {
    const list = el("div", "list");
    list.append(el("h2", null, `Problems (${result.problems.length})`));
    for (const p of result.problems) list.append(el("div", "problem", p));
    body.append(list);
  }

  // A trimmed OK list so a green result shows its work.
  if (result.ok && result.ok.length) {
    const list = el("div", "list");
    const wrap = el("details");
    const sum = el("summary", null, `Verified (${result.ok.length})`);
    wrap.append(sum);
    for (const o of result.ok) wrap.append(el("div", "okrow", `ok  ${o}`));
    list.append(wrap);
    body.append(list);
  }
}

load().catch((err) => {
  const headline = document.getElementById("headline");
  if (headline) headline.textContent = `popup error: ${String(err)}`;
});
