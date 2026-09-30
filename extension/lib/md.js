/*
 * Minimal, safe Markdown → HTML for AI answers (same approach as the server
 * web UI's md.js). Everything is HTML-escaped first; only a small whitelist of
 * constructs is turned back into tags, and links are limited to http(s).
 * The output is the only HTML the side panel ever assigns to innerHTML.
 */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline markup on an already-escaped line. */
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/\*\*/g, "")
    // Only http(s) links; the URL is already escaped, so it cannot close the attribute.
    .replace(/\[([^\]]+)\]\((?:&lt;)?(https?:\/\/[^\s)]+?)(?:&gt;)?\)/g,
      (m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`)
    .replace(/\[(doc|meeting):([^\]]+)\]/g, '<span class="ref">$1:$2</span>');
}

export function renderMarkdown(md) {
  const lines = escapeHtml(md || "").split("\n");
  const out = [];
  let list = null;
  let table = false;
  let quote = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => {
    if (!quote) return;
    const q = quote.filter(Boolean);
    if (q.length) out.push(`<blockquote>${q.map((l) => `<p>${inline(l)}</p>`).join("")}</blockquote>`);
    quote = null;
  };
  const closeTable = () => { if (table) { out.push("</tbody></table>"); table = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const qm = /^&gt;\s?(.*)$/.exec(line.trim());
    if (qm) { closeList(); closeTable(); (quote = quote || []).push(qm[1].trim()); continue; }
    closeQuote();
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList(); closeTable();
      if (out.length && out[out.length - 1] !== "<hr>") out.push("<hr>");
      continue;
    }
    const cells = /^\|(.+)\|$/.exec(line.trim());
    if (cells) {
      closeList();
      const parts = cells[1].split("|").map((c) => c.trim());
      if (parts.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      if (!table) {
        out.push("<table><tbody>");
        table = true;
        out.push(`<tr>${parts.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`);
        continue;
      }
      out.push(`<tr>${parts.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    closeTable();
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      const lvl = Math.min(m[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
      if (list !== "ol") { closeList(); out.push(m[1] === "1" ? "<ol>" : `<ol start="${m[1]}">`); list = "ol"; }
      out.push(`<li>${inline(m[2])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeQuote();
  closeList();
  closeTable();
  while (out[0] === "<hr>") out.shift();
  while (out[out.length - 1] === "<hr>") out.pop();
  return out.join("\n");
}

/** Only http(s) URLs may become links (answer sources, report links). */
export function safeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}
