'use strict';
// Unit tests for recapper/web/static/capture.js, loaded into a vm context with
// a fake `window` (no browser needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CAPTURE_JS = path.resolve(__dirname, '..', '..', '..', 'recapper', 'web', 'static', 'capture.js');
const SOURCE = fs.readFileSync(CAPTURE_JS, 'utf8');

function loadCapture(extra = {}) {
  const sandbox = {
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    performance, FormData, Blob, URL, AbortController, Response, console,
    ...extra,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'capture.js' });
  return sandbox;
}

const { RecapperCapture } = loadCapture();
const I = RecapperCapture._internals;

function sine(freq, rate, seconds, amp = 0.5) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function noise(n, amp, seed = 1) {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

// ------------------------------------------------------------------ WAV ---
test('encodeWav writes a valid 16 kHz mono PCM16 header', () => {
  const buf = I.encodeWav(new Float32Array(1600), 16000);
  const v = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  assert.equal(buf.byteLength, 44 + 3200);
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 3200);
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000, 'byte rate');
  assert.equal(v.getUint16(32, true), 2, 'block align');
  assert.equal(v.getUint16(34, true), 16, 'bits');
  assert.equal(str(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 3200);
});

test('encodeWav converts, clamps and sanitises samples', () => {
  const buf = I.encodeWav(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -3, NaN]), 8000);
  const pcm = Array.from(new Int16Array(buf.slice(44)));
  assert.deepEqual(pcm, [0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
  assert.equal(new DataView(buf).getUint32(24, true), 8000);
  assert.equal(I.encodeWav(new Float32Array(0), 16000).byteLength, 44);
});

// ------------------------------------------------------------ resampling ---
test('downsample 48k -> 16k: length, DC and in-band tone preserved', () => {
  const dc = new Float32Array(48000).fill(0.25);
  const out = I.downsample(dc, 48000, 16000);
  assert.equal(out.length, 16000);
  for (const x of out) assert.ok(Math.abs(x - 0.25) < 1e-5);

  const tone = I.downsample(sine(1000, 48000, 1), 48000, 16000);
  assert.equal(tone.length, 16000);
  const inner = tone.subarray(200, 15800);
  assert.ok(Math.abs(I.rms(inner) - 0.5 / Math.SQRT2) < 0.01, `rms ${I.rms(inner)}`);
  let crossings = 0;
  for (let i = 1; i < inner.length; i++) if ((inner[i - 1] < 0) !== (inner[i] < 0)) crossings++;
  const hz = crossings / 2 / (inner.length / 16000);
  assert.ok(Math.abs(hz - 1000) < 5, `frequency ${hz}`);
});

test('downsample removes content above the new Nyquist (anti-aliasing)', () => {
  const high = sine(12000, 48000, 0.5); // would alias to 4 kHz without filtering
  const out = I.downsample(high, 48000, 16000);
  const inner = out.subarray(100, out.length - 100);
  assert.ok(I.rms(inner) < 0.02 * I.rms(high), `leak ${I.rms(inner)}`);
});

test('downsample handles 44.1k, equal rates, upsampling and bad input', () => {
  const x = sine(440, 44100, 1);
  const out = I.downsample(x, 44100, 16000);
  assert.equal(out.length, Math.floor(44100 / (44100 / 16000)));
  assert.ok(Math.abs(I.rms(out.subarray(200, out.length - 200)) - 0.5 / Math.SQRT2) < 0.01);

  const same = Float32Array.from([0.1, 0.2]);
  const copy = I.downsample(same, 16000, 16000);
  assert.deepEqual(Array.from(copy), Array.from(same));
  assert.notEqual(copy, same, 'returns a copy');

  const up = I.downsample(Float32Array.from([0, 1, 0, -1]), 8000, 16000);
  assert.equal(up.length, 8);
  assert.deepEqual(Array.from(up).map((v) => Math.round(v * 100) / 100), [0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);

  assert.equal(I.downsample(new Float32Array(0), 48000, 16000).length, 0);
  assert.equal(I.downsample(new Float32Array(2), 48000, 16000).length, 0);
  assert.throws(() => I.downsample(new Float32Array(4), 0, 16000), /positive/);
  assert.throws(() => I.downsample(new Float32Array(4), 48000, -1), /positive/);
});

// ------------------------------------------------------- levels & cutting ---
test('rms and peak-frame silence detection', () => {
  assert.equal(I.rms(new Float32Array(0)), 0);
  assert.equal(I.rms(new Float32Array(10).fill(0.5)), 0.5);
  assert.ok(Math.abs(I.rms(sine(100, 16000, 1, 1)) - Math.SQRT1_2) < 1e-3);

  const quiet = noise(16000 * 5, 0.001);
  assert.ok(I.isSilent(quiet, 16000, 0.004));
  // A short command in a long silence must not be skipped.
  const withWord = quiet.slice();
  withWord.set(sine(300, 16000, 0.15, 0.2), 16000 * 2);
  assert.ok(I.rms(withWord) < 0.03, 'whole-chunk RMS is low');
  assert.ok(!I.isSilent(withWord, 16000, 0.004), 'but a 100 ms frame is loud');
  assert.ok(I.isSilent(new Float32Array(0), 16000, 0.004));
  assert.ok(I.peakFrameRms(withWord, 16000, 0.1) > 0.1);
});

test('findCutIndex lands in a pause near the target', () => {
  const rate = 16000;
  const x = noise(rate * 12, 0.3);
  const gapStart = Math.round(rate * 10.9);
  x.fill(0, gapStart, gapStart + Math.round(rate * 0.2)); // 200 ms pause at 10.9 s
  const cut = I.findCutIndex(x, rate, rate * 12, rate * 2);
  assert.ok(cut >= gapStart && cut <= gapStart + rate * 0.2, `cut ${cut / rate}s`);
  // no room to search -> the target itself
  assert.equal(I.findCutIndex(x, rate, 100, 0), 100);
});

test('Chunker emits contiguous ~chunkSeconds chunks and flushes the tail', () => {
  const rate = 16000;
  const chunks = [];
  const c = new I.Chunker(rate, 3, (ch) => chunks.push(ch));
  const signal = noise(rate * 10, 0.2);
  for (let i = 0; i < signal.length; i += 128) c.push(signal.subarray(i, Math.min(i + 128, signal.length)).slice());
  assert.equal(chunks.length, 3);
  let expectedStart = 0;
  for (const ch of chunks) {
    assert.equal(ch.startSample, expectedStart);
    assert.equal(ch.sampleRate, rate);
    assert.ok(ch.samples.length <= rate * 3 && ch.samples.length >= rate * 3 - rate * 0.75, `len ${ch.samples.length}`);
    expectedStart += ch.samples.length;
  }
  c.flush(0.4);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[3].startSample, expectedStart);
  assert.equal(expectedStart + chunks[3].samples.length, signal.length, 'no samples lost');

  // A tail shorter than minSeconds is dropped but still advances the clock.
  const c2 = new I.Chunker(rate, 3, (ch) => chunks.push(ch));
  c2.push(new Float32Array(1000));
  c2.flush(0.4);
  assert.equal(chunks.length, 4);
  assert.equal(c2.consumed, 1000);
});

// ---------------------------------------------------------------- upload ---
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handler) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await handler(calls.length, url, init);
    } finally {
      inFlight--;
    }
  };
  fn.calls = calls;
  fn.maxInFlight = () => maxInFlight;
  return fn;
}

function item(seq, offset = seq * 12) {
  return { wav: I.encodeWav(new Float32Array(160), 16000), offset, duration: 12, seq };
}

test('Uploader sends chunks one at a time, in order, with auth and form fields', async () => {
  const results = [];
  const errors = [];
  const fetch = fakeFetch((n) => jsonResponse(200, { added: 1, segments: [{ text: `s${n}` }], new_items: [] }));
  const up = new I.Uploader({
    url: '/api/live/abc/audio', token: 'tok', source: 'system', fetch,
    onResult: (body, meta) => results.push([body.segments[0].text, meta.seq, meta.source]),
    onError: (e) => errors.push(e),
  });
  for (let i = 0; i < 4; i++) up.enqueue(item(i, i * 12.5));
  assert.equal(await up.drain(5000), true);
  assert.equal(fetch.maxInFlight(), 1, 'serialized');
  assert.deepEqual(results, [['s1', 0, 'system'], ['s2', 1, 'system'], ['s3', 2, 'system'], ['s4', 3, 'system']]);
  assert.equal(errors.length, 0);
  const { url, init } = fetch.calls[2];
  assert.equal(url, '/api/live/abc/audio');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  const form = init.body;
  assert.equal(form.get('source'), 'system');
  assert.equal(form.get('offset'), '25.000');
  const file = form.get('file');
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.name, 'system-2.wav');
  const head = Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString('latin1');
  assert.equal(head, 'RIFF');
  assert.deepEqual({ ...up.stats }, { sent: 4, failed: 0, dropped: 0, retried: 0 });
});

test('Uploader retries a network error once, then reports it (non-fatal)', async () => {
  const errors = [];
  const results = [];
  const flaky = fakeFetch((n) => {
    if (n === 1) throw new TypeError('Failed to fetch');
    return jsonResponse(200, { added: 0, segments: [] });
  });
  const up = new I.Uploader({ url: '/u', source: 'mic', fetch: flaky, retryDelayMs: 1, onResult: (b, m) => results.push(m.seq), onError: (e) => errors.push(e) });
  up.enqueue(item(0));
  await up.drain(5000);
  assert.equal(flaky.calls.length, 2);
  assert.deepEqual(results, [0]);
  assert.equal(up.stats.retried, 1);
  assert.equal(errors.length, 0);

  const down = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  const up2 = new I.Uploader({ url: '/u', source: 'mic', fetch: down, retryDelayMs: 1, onResult: () => {}, onError: (e) => errors.push(e) });
  up2.enqueue(item(0));
  up2.enqueue(item(1));
  await up2.drain(5000);
  assert.equal(down.calls.length, 4, 'two attempts per chunk');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].code, 'network');
  assert.equal(errors[0].fatal, false);
  assert.equal(errors[0].source, 'mic');
});

test('Uploader surfaces 409/503 as fatal errors and other HTTP errors as non-fatal (no retry)', async () => {
  const cases = [
    [409, 'session_closed', true, /завершена/],
    [503, 'asr_unavailable', true, /Распознавание/],
    [401, 'unauthorized', true, /токен/],
    [500, 'http_500', false, /500/],
    [422, 'http_422', false, /422/],
  ];
  for (const [status, code, fatal, re] of cases) {
    const errors = [];
    const fetch = fakeFetch(() => jsonResponse(status, { detail: `detail-${status}` }));
    const up = new I.Uploader({ url: '/u', source: 'mic', fetch, retryDelayMs: 1, onResult: () => {}, onError: (e) => errors.push(e) });
    up.enqueue(item(0));
    await up.drain(5000);
    assert.equal(fetch.calls.length, 1, `no retry for ${status}`);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, status);
    assert.equal(errors[0].code, code);
    assert.equal(errors[0].fatal, fatal);
    assert.match(errors[0].message, re);
    assert.match(errors[0].message, new RegExp(`detail-${status}`));
  }
});

// --------------------------------------------------------------- options ---
test('resolveOptions: explicit options, then backend settings, then defaults', () => {
  const v = { capture_chunk_seconds: 8, capture_sources: ['mic'], capture_silence_threshold: 0.01 };
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(I.resolveOptions({}, v)), { chunkSeconds: 8, sources: ['mic'], silenceThreshold: 0.01 });
  assert.deepEqual(plain(I.resolveOptions({ chunkSeconds: 5, sources: ['system'], silenceThreshold: 0 }, v)),
    { chunkSeconds: 5, sources: ['system'], silenceThreshold: 0 });
  assert.deepEqual(plain(I.resolveOptions({}, null)), { chunkSeconds: 12, sources: ['mic', 'system'], silenceThreshold: 0.004 });
  assert.deepEqual(plain(I.resolveOptions({}, { capture_chunk_seconds: 'x', capture_sources: ['bogus'], capture_silence_threshold: 5 })),
    { chunkSeconds: 12, sources: ['mic', 'system'], silenceThreshold: 0.004 });
});

test('fetchSettings sends the token and tolerates failures', async () => {
  const f = fakeFetch(() => jsonResponse(200, { values: { capture_chunk_seconds: 7 }, schema: [] }));
  const values = await I.fetchSettings('http://h', 'tok', f);
  assert.equal(values.capture_chunk_seconds, 7);
  assert.equal(f.calls[0].url, 'http://h/api/settings');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(await I.fetchSettings('', 't', fakeFetch(() => jsonResponse(404, {}))), null);
  assert.equal(await I.fetchSettings('', 't', fakeFetch(() => { throw new Error('down'); })), null);
});

// ------------------------------------------------- controller (fake media) ---
/** Minimal Web Audio + MediaDevices fake: ScriptProcessor path, driven manually. */
function fakeMediaEnv({ micFails = false, systemFails = false, rate = 16000, bridge = null } = {}) {
  const env = { contexts: [], processors: [], tracks: [], displayCalls: 0, userCalls: 0, bridgeCalls: [] };
  class Track {
    constructor(kind) { this.kind = kind; this.stopped = false; this.listeners = {}; env.tracks.push(this); }
    stop() { this.stopped = true; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks.slice(); }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
    removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
  }
  class AudioContext {
    constructor(opts) { this.sampleRate = (opts && opts.sampleRate) || rate; this.state = 'running'; this.destination = {}; env.contexts.push(this); }
    createMediaStreamSource(stream) { return { stream, connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createScriptProcessor(size) {
      const p = { size, connected: true, connect() {}, disconnect() { p.connected = false; }, ctx: this };
      env.processors.push(p);
      return p;
    }
    async close() { this.state = 'closed'; }
    async resume() { this.state = 'running'; }
  }
  const navigator = {
    mediaDevices: {
      async getUserMedia() { env.userCalls++; if (micFails) throw new Error('Permission denied'); return new Stream([new Track('audio')]); },
      async getDisplayMedia() {
        env.displayCalls++;
        if (systemFails) throw new Error('NotReadableError: no loopback');
        return new Stream([new Track('video'), new Track('audio')]);
      },
    },
  };
  env.feed = (proc, samples) => proc.onaudioprocess({
    inputBuffer: { getChannelData: () => samples },
    outputBuffer: { getChannelData: () => new Float32Array(samples.length) },
  });
  const extra = { AudioContext, navigator };
  if (bridge) {
    extra.recapperDesktop = {
      platform: 'linux',
      enableLoopbackAudio: async () => { env.bridgeCalls.push('enable'); },
      disableLoopbackAudio: async () => { env.bridgeCalls.push('disable'); },
      setCapturing: async (on) => { env.bridgeCalls.push(`capturing:${on}`); },
    };
  }
  return { env, extra };
}

function serverFetch({ audioStatus = 200 } = {}) {
  const uploads = [];
  const f = fakeFetch(async (n, url, init) => {
    if (url.endsWith('/api/settings')) return jsonResponse(200, { values: { capture_chunk_seconds: 2, capture_sources: ['mic', 'system'], capture_silence_threshold: 0.004 } });
    uploads.push({ source: init.body.get('source'), offset: Number(init.body.get('offset')), file: init.body.get('file') });
    if (audioStatus !== 200) return jsonResponse(audioStatus, { detail: 'nope' });
    return jsonResponse(200, { added: 1, segments: [{ text: 'hi' }], new_items: [] });
  });
  f.uploads = uploads;
  return f;
}

test('controller: desktop, system audio fails -> mic-only with a warning; stop() flushes', async () => {
  const { env, extra } = fakeMediaEnv({ systemFails: true, bridge: true });
  const fetch = serverFetch();
  const w = loadCapture({ ...extra, fetch });
  const statuses = [];
  const results = [];
  const info = await w.RecapperCapture.start({
    sessionId: 's 1', token: 't',
    onStatus: (msg, d) => statuses.push([msg, d.code, d.level]),
    onResult: (b, m) => results.push(m),
  });
  assert.equal(w.RecapperCapture.isDesktop, true);
  assert.equal(w.RecapperCapture.running, true);
  assert.deepEqual(Array.from(info.sources), ['mic']);
  assert.equal(info.config.chunkSeconds, 2, 'chunk length came from /api/settings');
  assert.deepEqual(env.bridgeCalls.slice(0, 2), ['enable', 'disable'], 'loopback enabled then disabled');
  assert.ok(env.bridgeCalls.includes('capturing:true'));
  const warn = statuses.find((s) => s[1] === 'system_unavailable');
  assert.ok(warn, JSON.stringify(statuses));
  assert.equal(warn[2], 'warning');
  assert.match(warn[0], /Продолжаю только с микрофоном/);
  assert.equal(typeof statuses[0][0], 'string', 'onStatus gets a plain message first');

  // 5 s of audible audio at 16 kHz in 4096 blocks -> 2 full chunks, then a 1 s tail on stop()
  const proc = env.processors[0];
  const signal = noise(16000 * 5, 0.2);
  for (let i = 0; i < signal.length; i += 4096) env.feed(proc, signal.slice(i, i + 4096));
  // silence is skipped
  for (let i = 0; i < 16000 * 2.5; i += 4096) env.feed(proc, new Float32Array(4096));
  await w.RecapperCapture.stop();
  assert.equal(w.RecapperCapture.running, false);
  assert.ok(fetch.uploads.length >= 3, `uploads ${fetch.uploads.length}`);
  assert.ok(fetch.uploads.every((u) => u.source === 'mic'));
  const offsets = fetch.uploads.map((u) => u.offset);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1], 'offsets increase');
  assert.equal(results.length, fetch.uploads.length);
  assert.ok(env.tracks.every((t) => t.stopped), 'all tracks stopped (including the discarded video track)');
  assert.ok(env.contexts.every((c) => c.state === 'closed'));
  assert.ok(env.bridgeCalls.includes('capturing:false'));
  const stats = w.RecapperCapture.stats();
  assert.ok(stats.mic.skipped >= 1, 'silent chunk skipped');
  assert.equal(stats.mic.sent, fetch.uploads.length);
  assert.ok(statuses.some((s) => s[1] === 'stopped'));
});

test('controller: both sources, per-source uploads; 409 stops capture automatically', async () => {
  const { env, extra } = fakeMediaEnv({ bridge: true });
  const fetch = serverFetch({ audioStatus: 409 });
  const w = loadCapture({ ...extra, fetch });
  const errors = [];
  const info = await w.RecapperCapture.start({ sessionId: 'x', token: 't', chunkSeconds: 1, sources: ['mic', 'system'], silenceThreshold: 0.004, onError: (e) => errors.push(e) });
  assert.deepEqual(Array.from(info.sources).sort(), ['mic', 'system']);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/api/settings')).length, 0, 'no settings fetch when all options given');
  assert.equal(env.processors.length, 2, 'one processing chain per source');
  assert.notEqual(env.processors[0].ctx, env.processors[1].ctx, 'separate AudioContexts');
  const signal = noise(16000 * 1.5, 0.2);
  env.feed(env.processors[1], signal);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 409);
  assert.equal(errors[0].fatal, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.RecapperCapture.running, false, 'stopped after fatal error');
  assert.ok(env.tracks.every((t) => t.stopped));
});

test('controller: browser mode asks for the tab first; all sources failing rejects and cleans up', async () => {
  const { env, extra } = fakeMediaEnv({ micFails: true, systemFails: true });
  const fetch = serverFetch();
  const w = loadCapture({ ...extra, fetch });
  assert.equal(w.RecapperCapture.isDesktop, false);
  await assert.rejects(w.RecapperCapture.start({ sessionId: 'x', token: 't' }), (e) => e.code === 'no_sources' && /Микрофон недоступен/.test(e.message));
  assert.equal(env.displayCalls, 1);
  assert.equal(env.userCalls, 1);
  assert.equal(w.RecapperCapture.running, false);
  await w.RecapperCapture.stop(); // safe after a failed start
  // and a new start is possible afterwards
  await assert.rejects(w.RecapperCapture.start({ sessionId: 'x' }), /no_sources|источник/);
});

test('controller: start() validates input and refuses a second concurrent capture', async () => {
  const { extra } = fakeMediaEnv({});
  const w = loadCapture({ ...extra, fetch: serverFetch() });
  await assert.rejects(w.RecapperCapture.start({}), /sessionId/);
  await w.RecapperCapture.start({ sessionId: 'a', sources: ['mic'], chunkSeconds: 2, silenceThreshold: 0.004 });
  await assert.rejects(w.RecapperCapture.start({ sessionId: 'b' }), (e) => e.code === 'already_running');
  await w.RecapperCapture.stop();
  await w.RecapperCapture.stop(); // idempotent
});
