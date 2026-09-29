import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { crc32, listFiles, pack } from "../../scripts/pack.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

test("manifest: MV3, required permissions, local host permissions, optional https", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Recapper — ассистент встреч");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "offscreen", "sidePanel", "storage", "tabCapture"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.ok(!("key" in manifest), "no pinned key: the store assigns the id");
  assert.ok(!("content_security_policy" in manifest), "default MV3 CSP (no remote code)");
});

test("every file the manifest and pages reference exists", () => {
  const refs = [
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    manifest.side_panel.default_path, manifest.background.service_worker,
    "offscreen.html", "offscreen.js", "permissions.html", "permissions.js", "capture-worklet.js", "sidepanel.js", "sidepanel.css",
  ];
  for (const f of refs) assert.ok(existsSync(join(root, f)), f);
  for (const page of ["sidepanel.html", "offscreen.html", "permissions.html"]) {
    const html = readFileSync(join(root, page), "utf8");
    for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) assert.ok(existsSync(join(root, m[1])), `${page} → ${m[1]}`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${page}: no inline scripts (MV3 CSP)`);
    assert.doesNotMatch(html, /\son[a-z]+=/i, `${page}: no inline event handlers (MV3 CSP)`);
  }
  for (const script of ["sidepanel.js", "offscreen.js", "permissions.js", "background.js"]) {
    const js = readFileSync(join(root, script), "utf8");
    for (const m of js.matchAll(/from "\.\/([^"]+)"/g)) assert.ok(existsSync(join(root, m[1])), `${script} → ${m[1]}`);
    assert.doesNotMatch(js, /\beval\(|new Function\(/, `${script}: no eval`);
  }
});

test("pure modules do not touch chrome.* or the DOM (unit-testable in Node)", () => {
  for (const f of ["api.js", "capture-config.js", "chunker.js", "dsp.js", "i18n.js", "md.js", "reducer.js", "uploader.js", "wav.js"]) {
    const src = readFileSync(join(root, "lib", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\bchrome\.|\bdocument\.|\bwindow\./, f);
  }
});

/** Minimal ZIP reader (central directory) to verify the package. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(crc32(data), crc, `${name} crc`);
    entries[name] = data;
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("pack.mjs builds dist/recapper-extension-<version>.zip without tests, scripts or node_modules", () => {
  const out = mkdtempSync(join(tmpdir(), "recapper-pack-"));
  try {
    const res = pack({ outDir: out });
    assert.equal(res.out, join(out, `recapper-extension-${manifest.version}.zip`));
    const entries = readZip(readFileSync(res.out));
    const names = Object.keys(entries);
    for (const required of ["manifest.json", "background.js", "sidepanel.html", "sidepanel.js", "offscreen.html", "offscreen.js",
      "permissions.html", "capture-worklet.js", "lib/wav.js", "lib/md.js", "icons/icon128.png"]) {
      assert.ok(names.includes(required), required);
    }
    assert.ok(!names.some((n) => /^(test|scripts|node_modules|dist)\//.test(n) || n === "package.json"), names.join(", "));
    assert.deepEqual(entries["manifest.json"], readFileSync(join(root, "manifest.json")));
    assert.deepEqual(names, listFiles(root));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
