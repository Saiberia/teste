/*
 * WAV (RIFF, PCM16, mono) encoding and parsing. Pure: no browser or chrome.* APIs.
 */

export const TARGET_RATE = 16000;
const HEADER_BYTES = 44;

/**
 * Encodes mono float samples (-1..1) as a 16-bit PCM WAV file.
 * Out-of-range values are clamped, NaN becomes silence.
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  if (!(sampleRate > 0) || !Number.isInteger(sampleRate)) throw new RangeError("sampleRate must be a positive integer");
  const n = samples.length;
  const buffer = new ArrayBuffer(HEADER_BYTES + n * 2);
  const v = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0, off = HEADER_BYTES; i < n; i++, off += 2) {
    let s = samples[i];
    s = s > 1 ? 1 : s < -1 ? -1 : s !== s ? 0 : s; // eslint-disable-line no-self-compare
    v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return buffer;
}

/**
 * Parses a RIFF/WAVE file (walks the chunk list, so extra chunks are fine).
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{format:number, channels:number, sampleRate:number, byteRate:number, blockAlign:number,
 *            bitsPerSample:number, dataOffset:number, dataLength:number, frames:number, duration:number,
 *            samples: Int16Array|null}}
 */
export function parseWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("fmt chunk too short");
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        byteRate: v.getUint32(body + 8, true),
        blockAlign: v.getUint16(body + 12, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = { offset: body, length: Math.min(size, bytes.byteLength - body) };
      break;
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error("missing fmt chunk");
  if (!data) throw new Error("missing data chunk");
  const frames = fmt.blockAlign ? Math.floor(data.length / fmt.blockAlign) : 0;
  let samples = null;
  if (fmt.format === 1 && fmt.bitsPerSample === 16) {
    samples = new Int16Array(Math.floor(data.length / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = v.getInt16(data.offset + i * 2, true);
  }
  return {
    ...fmt,
    dataOffset: data.offset,
    dataLength: data.length,
    frames,
    duration: fmt.sampleRate ? frames / fmt.sampleRate : 0,
    samples,
  };
}
