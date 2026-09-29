/* Minimal, safe Markdown -> HTML for AI answers.
   Everything is HTML-escaped first; only a small whitelist of constructs is
   turned back into tags, and links are limited to http(s). */
(function () {
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((?:&lt;)?(https?:\/\/[^\s)]+?)(?:&gt;)?\)/g,
        (m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`)
      .replace(/\[(doc|meeting):([^\]]+)\]/g, '<span class="ref">$1:$2</span>');
  }
  function render(md) {
    const lines = esc(md || "").split("\n");
    const out = [];
    let list = null, table = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeTable = () => { if (table) { out.push("</tbody></table>"); table = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const cells = /^\|(.+)\|$/.exec(line.trim());
      if (cells) {
        closeList();
        const parts = cells[1].split("|").map((c) => c.trim());
        if (parts.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
        if (!table) { out.push('<table><tbody>'); table = true; out.push("<tr>" + parts.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr>"); continue; }
        out.push("<tr>" + parts.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
        continue;
      }
      closeTable();
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { closeList(); const lvl = Math.min(m[1].length + 2, 6); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); continue; }
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = /^&gt;\s?(.*)$/.exec(line))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      closeList();
      if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    closeList(); closeTable();
    return out.join("\n");
  }
  window.RecapperMarkdown = { render, esc };
})();
