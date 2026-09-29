// Generates the extension icons (icons/icon{16,32,48,128}.png): a blue rounded
// square with a white sound-wave. Dependency-free PNG encoder (node:zlib).
// Usage: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SS = 4; // supersampling per axis

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bars = [0.28, 0.52, 0.78, 0.52, 0.28]; // relative heights
  const barW = 0.1;
  const gap = 0.06;
  const total = bars.length * barW + (bars.length - 1) * gap;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) continue;
          bg++;
          let bx = 0.5 - total / 2;
          for (const hgt of bars) {
            if (inRoundRect(x, y, bx, 0.5 - hgt / 2, bx + barW, 0.5 + hgt / 2, barW / 2)) { fg++; break; }
            bx += barW + gap;
          }
        }
      }
      const n = SS * SS;
      const o = (py * size + px) * 4;
      const tt = py / size; // vertical gradient #4c6ef5 → #3b5bdb
      const base = [0x4c + (0x3b - 0x4c) * tt, 0x6e + (0x5b - 0x6e) * tt, 0xf5 + (0xdb - 0xf5) * tt];
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      rgba[o] = Math.round(base[0] * (1 - f) + 255 * f);
      rgba[o + 1] = Math.round(base[1] * (1 - f) + 255 * f);
      rgba[o + 2] = Math.round(base[2] * (1 - f) + 255 * f);
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, rgba);
}

mkdirSync(join(root, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(root, "icons", `icon${size}.png`), draw(size));
}
console.log("icons written to", join(root, "icons"));
