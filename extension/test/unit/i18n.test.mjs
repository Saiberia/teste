import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DICTS, LANGS, makeT, pickLanguage, translate } from "../../lib/i18n.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("ru and en have exactly the same keys and no empty strings", () => {
  assert.deepEqual(LANGS, ["ru", "en"]);
  const ru = Object.keys(DICTS.ru).sort();
  const en = Object.keys(DICTS.en).sort();
  assert.deepEqual(en, ru);
  for (const [lang, dict] of Object.entries(DICTS)) {
    for (const [k, v] of Object.entries(dict)) assert.ok(typeof v === "string" && v.trim(), `${lang}.${k} is empty`);
  }
});

test("placeholders match between languages", () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of Object.keys(DICTS.ru)) assert.equal(ph(DICTS.en[k]), ph(DICTS.ru[k]), k);
});

test("language comes from the server setting; Russian by default", () => {
  assert.equal(pickLanguage("en"), "en");
  assert.equal(pickLanguage("EN-us"), "en");
  assert.equal(pickLanguage("ru"), "ru");
  assert.equal(pickLanguage("de"), "ru");
  assert.equal(pickLanguage(undefined), "ru");
  assert.equal(makeT("en")("start"), "Start recording");
  assert.equal(makeT("ru")("start"), "Начать запись");
  assert.equal(makeT("xx").lang, "ru");
});

test("translate fills placeholders and falls back to the key", () => {
  assert.equal(translate("ru", "sent_chunks", { n: 3 }), "отправлено фрагментов: 3");
  assert.equal(translate("en", "target_tab", { title: "Meet" }), "Tab: Meet");
  assert.equal(translate("ru", "target_tab", {}), "Вкладка: {title}", "unknown vars stay visible");
  assert.equal(translate("en", "no_such_key"), "no_such_key");
});

test("every data-i18n key used in the HTML pages and t() key in the scripts exists", () => {
  const keys = new Set(Object.keys(DICTS.ru));
  for (const page of ["sidepanel.html", "permissions.html"]) {
    const html = readFileSync(join(root, page), "utf8");
    for (const m of html.matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) assert.ok(keys.has(m[1]), `${page}: ${m[1]}`);
  }
  for (const script of ["sidepanel.js", "permissions.js"]) {
    const js = readFileSync(join(root, script), "utf8");
    for (const m of js.matchAll(/\bt\("([a-z_]+)"/g)) assert.ok(keys.has(m[1]), `${script}: t("${m[1]}")`);
  }
});
