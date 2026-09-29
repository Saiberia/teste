import { test } from "node:test";
import assert from "node:assert/strict";
import { Chunker, findCutIndex, prepareChunk } from "../../lib/chunker.js";
import { resolveCaptureOptions, selectedSources } from "../../lib/capture-config.js";
import { parseWav } from "../../lib/wav.js";

const tone = (n, amp = 0.3, rate = 48000, freq = 300) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

function feed(chunker, samples, block = 2048) {
  for (let i = 0; i < samples.length; i += block) chunker.push(samples.subarray(i, i + block));
}

test("chunker emits contiguous ~N-second chunks and flushes the tail", () => {
  const rate = 48000;
  const chunks = [];
  const c = new Chunker(rate, 12, (x) => chunks.push(x));
  feed(c, tone(rate * 30), 128); // AudioWorklet render quantum
  assert.equal(chunks.length, 2);
  let expectedStart = 0;
  for (const ch of chunks) {
    assert.equal(ch.sampleRate, rate);
    assert.equal(ch.startSample, expectedStart, "chunks are contiguous");
    const seconds = ch.samples.length / rate;
    assert.ok(seconds >= 10 && seconds <= 12, `chunk length ${seconds}s`);
    expectedStart += ch.samples.length;
  }
  c.flush(0.4);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2].startSample, expectedStart);
  const total = chunks.reduce((a, ch) => a + ch.samples.length, 0);
  assert.equal(total, rate * 30, "no sample lost or duplicated");
});

test("a short tail is dropped on flush but still advances the offset", () => {
  const rate = 16000;
  const chunks = [];
  const c = new Chunker(rate, 4, (x) => chunks.push(x));
  feed(c, tone(rate * 4 + rate * 0.2, 0.3, rate));
  assert.equal(chunks.length, 1);
  const tail = rate * 4.2 - chunks[0].samples.length;
  assert.ok(tail < rate * 0.4, `tail ${tail / rate}s`);
  c.flush(0.4);
  assert.equal(chunks.length, 1, "short tail dropped");
  feed(c, tone(rate * 4, 0.3, rate));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].startSample, rate * 4.2, "the dropped tail still counts for later offsets");
});

test("chunks are cut in the quietest moment near the boundary", () => {
  const rate = 16000;
  const samples = tone(rate * 5, 0.5, rate);
  const pauseAt = Math.round(rate * 3.5); // 100 ms pause, 0.5 s before the 4 s boundary
  samples.fill(0, pauseAt, pauseAt + rate * 0.1);
  const cut = findCutIndex(samples, rate, rate * 4, rate * 1);
  assert.ok(cut >= pauseAt && cut <= pauseAt + rate * 0.1, `cut at ${cut / rate}s`);
  const chunks = [];
  const c = new Chunker(rate, 4, (x) => chunks.push(x));
  feed(c, samples);
  assert.ok(Math.abs(chunks[0].samples.length - cut) <= rate * 0.02);
});

test("prepareChunk resamples to a 16 kHz WAV and computes the offset", () => {
  const rate = 48000;
  const job = prepareChunk({ samples: tone(rate * 2), sampleRate: rate, startSample: rate * 10 }, {
    startOffset: 1.5, silenceThreshold: 0.004,
  });
  assert.equal(job.skip, false);
  assert.equal(job.offset, 11.5);
  assert.equal(job.duration, 2);
  const info = parseWav(job.wav);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.frames, 32000);
});

test("prepareChunk skips silent chunks", () => {
  const job = prepareChunk({ samples: new Float32Array(48000 * 4), sampleRate: 48000, startSample: 0 }, {
    silenceThreshold: 0.004,
  });
  assert.equal(job.skip, true);
  assert.equal(job.wav, undefined);
  assert.equal(job.duration, 4);
  const quiet = prepareChunk({ samples: tone(48000, 0.003), sampleRate: 48000, startSample: 0 }, { silenceThreshold: 0.004 });
  assert.equal(quiet.skip, true, "RMS 0.0021 < 0.004");
  const loud = prepareChunk({ samples: tone(48000, 0.01), sampleRate: 48000, startSample: 0 }, { silenceThreshold: 0.004 });
  assert.equal(loud.skip, false, "RMS 0.0071 >= 0.004");
});

test("capture options come from server settings with safe defaults", () => {
  assert.deepEqual(resolveCaptureOptions(null), { chunkSeconds: 12, silenceThreshold: 0.004 });
  assert.deepEqual(resolveCaptureOptions({ capture_chunk_seconds: 4, capture_silence_threshold: 0.01 }),
    { chunkSeconds: 4, silenceThreshold: 0.01 });
  assert.deepEqual(resolveCaptureOptions({ capture_chunk_seconds: "abc", capture_silence_threshold: -1 }),
    { chunkSeconds: 12, silenceThreshold: 0.004 });
  assert.equal(resolveCaptureOptions({ capture_chunk_seconds: 1000 }).chunkSeconds, 60);
  assert.equal(resolveCaptureOptions({ capture_chunk_seconds: 0 }).chunkSeconds, 2);
  assert.equal(resolveCaptureOptions({ capture_silence_threshold: 0 }).silenceThreshold, 0);
  assert.deepEqual(selectedSources({ tab: true, mic: true }), ["system", "mic"]);
  assert.deepEqual(selectedSources({ tab: false, mic: true }), ["mic"]);
  assert.deepEqual(selectedSources({ tab: false, mic: false }), []);
});
