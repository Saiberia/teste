import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, parseWav, TARGET_RATE } from "../../lib/wav.js";

test("encodeWav writes a 44-byte RIFF/WAVE PCM16 mono header that parses back", () => {
  const samples = Float32Array.from({ length: 1600 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5);
  const buf = encodeWav(samples, 16000);
  assert.equal(buf.byteLength, 44 + samples.length * 2);
  const bytes = new Uint8Array(buf);
  const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 12), "WAVE");
  assert.equal(ascii(12, 16), "fmt ");
  assert.equal(ascii(36, 40), "data");
  const v = new DataView(buf);
  assert.equal(v.getUint32(4, true), buf.byteLength - 8, "RIFF size = file size - 8");

  const info = parseWav(buf);
  assert.equal(info.format, 1, "PCM");
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, TARGET_RATE);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.blockAlign, 2);
  assert.equal(info.byteRate, 32000);
  assert.equal(info.dataOffset, 44);
  assert.equal(info.dataLength, samples.length * 2);
  assert.equal(info.frames, samples.length);
  assert.equal(info.duration, 0.1);
});

test("round trip keeps sample values within PCM16 quantization error", () => {
  const samples = Float32Array.from([0, 0.25, -0.25, 0.999, -0.999, 0.5, -0.5]);
  const { samples: pcm } = parseWav(encodeWav(samples));
  assert.equal(pcm.length, samples.length);
  samples.forEach((s, i) => {
    const back = pcm[i] < 0 ? pcm[i] / 0x8000 : pcm[i] / 0x7fff;
    assert.ok(Math.abs(back - s) <= 1 / 0x7fff, `sample ${i}: ${back} vs ${s}`);
  });
});

test("out-of-range values are clamped and NaN becomes silence", () => {
  const { samples: pcm } = parseWav(encodeWav(Float32Array.from([2, -3, NaN, 1, -1])));
  assert.deepEqual([...pcm], [32767, -32768, 0, 32767, -32768]);
});

test("empty input is a valid, empty WAV", () => {
  const info = parseWav(encodeWav(new Float32Array(0)));
  assert.equal(info.frames, 0);
  assert.equal(info.dataLength, 0);
});

test("other sample rates are written into the header", () => {
  assert.equal(parseWav(encodeWav(new Float32Array(10), 48000)).sampleRate, 48000);
  assert.throws(() => encodeWav(new Float32Array(1), 0), RangeError);
  assert.throws(() => encodeWav(new Float32Array(1), 44100.5), RangeError);
});

test("parseWav rejects non-WAV data and skips unknown chunks", () => {
  assert.throws(() => parseWav(new TextEncoder().encode("hello world, not a wav")), /RIFF/);
  // Insert a LIST chunk between fmt and data, as some encoders do.
  const plain = new Uint8Array(encodeWav(Float32Array.from([0.5, -0.5])));
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // "LIST", size 3 + pad
  const withList = new Uint8Array(plain.length + list.length);
  withList.set(plain.slice(0, 36));
  withList.set(list, 36);
  withList.set(plain.slice(36), 36 + list.length);
  const info = parseWav(withList);
  assert.equal(info.frames, 2);
  assert.equal(info.dataOffset, 44 + list.length);
});
