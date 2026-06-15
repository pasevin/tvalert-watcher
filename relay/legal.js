// Renders the Markdown legal docs (legal/*.md) into simple styled HTML so the
// relay can serve them at /privacy and /terms — public URLs for Stripe + the app.

import { readFileSync } from "node:fs";

function inline(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}

function mdToHtml(md) {
  md = md.replace(/<!--[\s\S]*?-->/g, "").trim(); // drop template comments
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      closeList();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line === "") {
      closeList();
    } else if (line.startsWith("_") && line.endsWith("_")) {
      closeList();
      out.push(`<p class="muted"><em>${inline(line.slice(1, -1))}</em></p>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — TradingView Alerts</title>` +
  `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1d1d1f;line-height:1.6}` +
  `h1{font-size:28px}h2{margin-top:32px;font-size:20px}.muted{color:#6e6e73}code{background:#f5f5f7;padding:1px 5px;border-radius:4px}a{color:#0a84ff}</style>` +
  `</head><body>${body}</body></html>`;

const cache = {};
export function renderLegal(name) {
  if (!cache[name]) {
    const file = name === "privacy" ? "PRIVACY.md" : "TERMS.md";
    const md = readFileSync(new URL(`./legal/${file}`, import.meta.url), "utf-8");
    cache[name] = page(name === "privacy" ? "Privacy Policy" : "Terms of Service", mdToHtml(md));
  }
  return cache[name];
}
