import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderMarkdown, safeHttpUrl } from "../../lib/md.js";

/** Every tag in the output must be one the renderer is allowed to produce. */
const ALLOWED = new Set(["p", "strong", "em", "code", "a", "span", "ul", "ol", "li", "h3", "h4", "h5", "h6", "blockquote", "table", "tbody", "tr", "th", "td"]);
function tags(html) {
  return [...html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2] }));
}
function assertSafe(html) {
  for (const { name, attrs } of tags(html)) {
    assert.ok(ALLOWED.has(name), `unexpected tag <${name}> in ${html}`);
    assert.doesNotMatch(attrs, /\son\w+\s*=/i, `event handler attribute in ${html}`);
    const href = /href="([^"]*)"/.exec(attrs);
    if (href) assert.match(href[1], /^https?:\/\//, `non-http link in ${html}`);
  }
  assert.doesNotMatch(html, /<(img|script|iframe|svg|object|embed|style|link|meta|form|input)\b/i);
}

test("raw HTML is escaped: <img onerror>, <script>, <svg onload>", () => {
  const payloads = [
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>",
    "<svg/onload=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "**<img src=x onerror=alert(1)>**",
    "- <iframe src=javascript:alert(1)>",
    "| <b onmouseover=alert(1)>x</b> | y |\n|---|---|\n| <img onerror=alert(1) src=x> | z |",
  ];
  for (const p of payloads) {
    const html = renderMarkdown(p);
    assertSafe(html);
    assert.ok(html.includes("&lt;"), `escaped: ${html}`);
  }
  assert.equal(renderMarkdown('<img src=x onerror="alert(1)">'), "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
});

test("javascript:, data: and vbscript: links are not turned into anchors", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "//evil.com"]) {
    const html = renderMarkdown(`[click](${url})`);
    assertSafe(html);
    assert.doesNotMatch(html, /<a\b/, `${url} → ${html}`);
  }
});

test("http(s) links become safe anchors; quotes cannot break out of href", () => {
  const html = renderMarkdown("[Док](https://example.com/a?b=1&c=2)");
  assert.equal(html, '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Док</a></p>');
  const tricky = renderMarkdown('[x](https://evil.com/"onmouseover="alert(1))');
  assertSafe(tricky);
  assert.doesNotMatch(tricky, /"\s*onmouseover=/);
  const spaced = renderMarkdown("[x](https://evil.com/ onmouseover=alert(1))");
  assertSafe(spaced);
  assert.doesNotMatch(spaced, /<a\b/);
});

test("supported markdown: headings, emphasis, code, lists, quotes, tables, refs", () => {
  const html = renderMarkdown([
    "## Механика",
    "Текст с **жирным**, *курсивом* и `кодом`.",
    "- пункт 1",
    "- пункт 2",
    "1. шаг",
    "2) шаг",
    "> цитата",
    "| Метрика | Значение |",
    "|---|---|",
    "| CR | 3% |",
    "См. [doc:pricing.md]",
  ].join("\n"));
  assertSafe(html);
  assert.match(html, /<h4>Механика<\/h4>/);
  assert.match(html, /<strong>жирным<\/strong>/);
  assert.match(html, /<em>курсивом<\/em>/);
  assert.match(html, /<code>кодом<\/code>/);
  assert.match(html, /<ul>\n<li>пункт 1<\/li>\n<li>пункт 2<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>шаг<\/li>\n<li>шаг<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote>цитата<\/blockquote>/);
  assert.match(html, /<table><tbody>\n<tr><th>Метрика<\/th><th>Значение<\/th><\/tr>\n<tr><td>CR<\/td><td>3%<\/td><\/tr>\n<\/tbody><\/table>/);
  assert.match(html, /<span class="ref">doc:pricing.md<\/span>/);
});

test("empty and non-string input", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderMarkdown(undefined), "");
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

test("safeHttpUrl only accepts http(s)", () => {
  assert.equal(safeHttpUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(safeHttpUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000/");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("doc:pricing.md"), null);
  assert.equal(safeHttpUrl("transcript"), null);
  assert.equal(safeHttpUrl(""), null);
});
