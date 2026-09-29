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
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
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
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push("</tbody></table>"); table = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
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
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
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
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = /^&gt;\s?(.*)$/.exec(line))) {
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  return out.join("\n");
}

/** Only http(s) URLs may become links (answer sources, report links). */
export function safeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}
