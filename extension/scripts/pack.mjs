// Packs the extension into dist/recapper-extension-<version>.zip (for the
// Chrome Web Store / Edge Add-ons upload, or to hand out for "Load unpacked"
// after unzipping). Tests, node_modules, dist and dev scripts are left out.
// Dependency-free: a small ZIP writer on top of node:zlib (works on Windows too).
//
// Usage: node scripts/pack.mjs [--out <dir>]
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { dirname, join, relative, sep, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDE_DIRS = new Set(["test", "node_modules", "dist", "scripts", ".git"]);
const EXCLUDE_FILES = new Set(["package.json", "package-lock.json", ".DS_Store", "Thumbs.db"]);

/** Files that go into the package, as sorted forward-slash paths relative to the extension root. */
export function listFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!EXCLUDE_DIRS.has(name) || dir !== root) walk(full);
      } else if (!EXCLUDE_FILES.has(name)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Checks that every file the manifest refers to is packaged. */
export function checkManifest(files, root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const refs = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    manifest.side_panel?.default_path,
    manifest.background?.service_worker,
  ].filter(Boolean));
  const missing = [...refs].filter((f) => !files.includes(f));
  if (missing.length) throw new Error(`manifest refers to missing files: ${missing.join(", ")}`);
  if ("key" in manifest) throw new Error('remove "key" from manifest.json before packaging (the store assigns the id)');
  return manifest;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (2026-01-01 00:00) keeps the archive reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** @param {Array<{name: string, data: Buffer}>} entries */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function pack({ root = ROOT, outDir = join(root, "dist") } = {}) {
  const files = listFiles(root);
  const manifest = checkManifest(files, root);
  const zip = buildZip(files.map((name) => ({ name, data: readFileSync(join(root, name)) })));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `recapper-extension-${manifest.version}.zip`);
  writeFileSync(out, zip);
  return { out, files, bytes: zip.length, version: manifest.version };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const i = process.argv.indexOf("--out");
  const res = pack(i > 0 ? { outDir: resolve(process.argv[i + 1]) } : {});
  console.log(`${res.out} (${res.files.length} files, ${res.bytes} bytes)`);
}
