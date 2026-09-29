import { test } from "node:test";
import assert from "node:assert/strict";
import { isSilent, peakFrameRms, resample, resampledLength, rms } from "../../lib/dsp.js";

const sine = (freq, rate, seconds, amp = 1) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

/** Frequency estimate from positive-going zero crossings. */
function frequency(samples, rate) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return crossings / (samples.length / rate);
}

test("resampled length math", () => {
  assert.equal(resampledLength(48000, 48000, 16000), 16000);
  assert.equal(resampledLength(44100, 44100, 16000), 16000);
  assert.equal(resampledLength(48000 * 12, 48000, 16000), 16000 * 12);
  assert.equal(resampledLength(1000, 44100, 16000), 362); // floor(1000 * 16000 / 44100) = 362.8…
  assert.equal(resampledLength(1234, 16000, 16000), 1234);
  assert.equal(resampledLength(8000, 8000, 16000), 16000);
  assert.equal(resampledLength(0, 48000, 16000), 0);
  assert.throws(() => resampledLength(10, 0, 16000), RangeError);
});

test("resample output length matches resampledLength for common device rates", () => {
  for (const rate of [8000, 16000, 22050, 32000, 44100, 48000, 96000]) {
    for (const n of [0, 1, 127, 128, 2048, 4096, rate]) {
      assert.equal(resample(new Float32Array(n), rate, 16000).length, resampledLength(n, rate, 16000), `${rate} Hz, ${n}`);
    }
  }
});

test("48 kHz → 16 kHz keeps a 440 Hz tone's pitch and level", () => {
  const out = resample(sine(440, 48000, 1, 0.5), 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(frequency(out, 16000) - 440) <= 2, `frequency ${frequency(out, 16000)}`);
  const level = rms(out.subarray(200, 15800)); // skip edges
  assert.ok(Math.abs(level - 0.5 / Math.SQRT2) < 0.01, `rms ${level}`);
});

test("44.1 kHz → 16 kHz keeps a 1 kHz tone's pitch", () => {
  const out = resample(sine(1000, 44100, 1, 0.8), 44100, 16000);
  assert.ok(Math.abs(frequency(out, 16000) - 1000) <= 3);
});

test("anti-aliasing: a 12 kHz tone (above the 8 kHz Nyquist of 16 kHz) is strongly attenuated", () => {
  const out = resample(sine(12000, 48000, 0.5, 0.8), 48000, 16000);
  const level = rms(out.subarray(100, out.length - 100));
  assert.ok(level < 0.02, `aliased energy too high: ${level}`);
});

test("same rate returns an equal copy; upsampling interpolates", () => {
  const input = Float32Array.from([0, 0.5, 1, 0.5]);
  const same = resample(input, 16000, 16000);
  assert.deepEqual([...same], [...input]);
  assert.notEqual(same, input);
  const up = resample(Float32Array.from([0, 1]), 8000, 16000);
  assert.deepEqual([...up], [0, 0.5, 1, 1]);
});

test("rms of a full-scale sine is 1/√2; of silence 0", () => {
  assert.ok(Math.abs(rms(sine(100, 16000, 1)) - Math.SQRT1_2) < 1e-3);
  assert.equal(rms(new Float32Array(100)), 0);
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(null), 0);
});

test("silence detection uses the loudest 100 ms frame", () => {
  const threshold = 0.004;
  assert.equal(isSilent(new Float32Array(16000 * 12), 16000, threshold), true);
  assert.equal(isSilent(new Float32Array(0), 16000, threshold), true);
  // Low hiss below the threshold is silence.
  const hiss = Float32Array.from({ length: 16000 * 2 }, (_, i) => (i % 2 ? 0.002 : -0.002));
  assert.equal(isSilent(hiss, 16000, threshold), true);
  // One short 200 ms word in a 12 s chunk is NOT silence, although the whole-chunk RMS is tiny.
  const chunk = new Float32Array(16000 * 12);
  chunk.set(sine(300, 16000, 0.2, 0.02), 16000 * 5);
  assert.ok(rms(chunk) < threshold, "whole-chunk RMS is below the threshold");
  assert.ok(peakFrameRms(chunk, 16000) > threshold);
  assert.equal(isSilent(chunk, 16000, threshold), false);
  // A zero threshold treats any sound as speech.
  assert.equal(isSilent(hiss, 16000, 0), false);
});
