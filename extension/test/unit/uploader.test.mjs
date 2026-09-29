import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAudioForm, isFatalStatus, Uploader, uploadErrorCode } from "../../lib/uploader.js";
import { encodeWav } from "../../lib/wav.js";

const wav = () => encodeWav(new Float32Array(160).fill(0.1));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function harness(respond) {
  const calls = [];
  const events = { results: [], errors: [], warnings: [] };
  let active = 0;
  let maxActive = 0;
  const fetch = async (url, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const form = init.body;
    calls.push({ url, init, source: form.get("source"), offset: form.get("offset"), file: form.get("file") });
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await respond(calls.length, calls.at(-1));
    } finally {
      active--;
    }
  };
  const up = new Uploader({
    url: "http://127.0.0.1:8000/api/live/abc/audio", token: "tok", source: "mic", fetch, retryDelayMs: 1,
    onResult: (body, meta) => events.results.push({ body, meta }),
    onError: (e) => events.errors.push(e),
    onWarning: (code) => events.warnings.push(code),
  });
  return { up, calls, events, maxActive: () => maxActive };
}

test("uploads are sequential, in order, with auth header and multipart fields", async () => {
  const { up, calls, events, maxActive } = harness(async (n) => json(200, { added: 1, n }));
  for (let i = 0; i < 3; i++) up.enqueue({ wav: wav(), offset: i * 12 + 0.5, duration: 12 });
  assert.equal(await up.drain(2000), true);
  assert.equal(maxActive(), 1, "never two requests in flight");
  assert.deepEqual(calls.map((c) => c.offset), ["0.500", "12.500", "24.500"]);
  assert.ok(calls.every((c) => c.source === "mic"));
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/live/abc/audio");
  assert.equal(calls[0].file.type, "audio/wav");
  assert.equal(calls[0].file.name, "mic-0.wav");
  assert.equal(new Uint8Array(await calls[0].file.arrayBuffer()).length, 44 + 320);
  assert.deepEqual(events.results.map((r) => r.body.n), [1, 2, 3]);
  assert.deepEqual(events.results.map((r) => r.meta.seq), [0, 1, 2]);
  assert.equal(up.stats.sent, 3);
});

test("a network error is retried once, then reported (non-fatal)", async () => {
  let attempts = 0;
  const flaky = harness(async () => { attempts++; if (attempts === 1) throw new TypeError("Failed to fetch"); return json(200, {}); });
  flaky.up.enqueue({ wav: wav(), offset: 0, duration: 1 });
  await flaky.up.drain(2000);
  assert.equal(flaky.calls.length, 2);
  assert.equal(flaky.up.stats.retried, 1);
  assert.equal(flaky.up.stats.sent, 1);
  assert.equal(flaky.events.errors.length, 0);

  const down = harness(async () => { throw new TypeError("Failed to fetch"); });
  down.up.enqueue({ wav: wav(), offset: 0, duration: 1 });
  down.up.enqueue({ wav: wav(), offset: 1, duration: 1 });
  await down.up.drain(2000);
  assert.equal(down.calls.length, 4, "two attempts per chunk, then move on");
  assert.equal(down.events.errors.length, 2);
  assert.equal(down.events.errors[0].code, "network");
  assert.equal(down.events.errors[0].fatal, false);
});

test("HTTP errors are classified: 401/404/409/503 fatal, 422 not; no retry on HTTP errors", async () => {
  const cases = [[401, "unauthorized", true], [404, "session_not_found", true], [409, "session_closed", true],
    [503, "asr_unavailable", true], [422, "http_422", false], [500, "http_500", false]];
  for (const [status, code, fatal] of cases) {
    const { up, calls, events } = harness(async () => json(status, { detail: `detail ${status}` }));
    up.enqueue({ wav: wav(), offset: 0, duration: 1 });
    await up.drain(2000);
    assert.equal(calls.length, 1, `${status}: not retried`);
    assert.equal(events.errors.length, 1);
    assert.equal(events.errors[0].code, code);
    assert.equal(events.errors[0].status, status);
    assert.equal(events.errors[0].fatal, fatal);
    assert.equal(events.errors[0].detail, `detail ${status}`);
    assert.equal(uploadErrorCode(status), code);
    assert.equal(isFatalStatus(status), fatal);
  }
  assert.equal(uploadErrorCode(0), "network");
});

test("close() drops queued chunks; the queue is bounded", async () => {
  const { up, calls, events } = harness(async () => json(200, {}));
  for (let i = 0; i < 45; i++) up.enqueue({ wav: wav(), offset: i, duration: 1 });
  assert.ok(events.warnings.includes("queue_overflow"));
  assert.ok(up.stats.dropped >= 4);
  up.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls.length <= 2, `sent ${calls.length} after close`);
  up.enqueue({ wav: wav(), offset: 99, duration: 1 });
  assert.equal(up.queue.length, 0, "closed uploader ignores new chunks");
});

test("buildAudioForm carries file, source and offset", async () => {
  const form = buildAudioForm({ wav: wav(), source: "system", offset: 3.14159, seq: 7 });
  assert.equal(form.get("source"), "system");
  assert.equal(form.get("offset"), "3.142");
  assert.equal(form.get("file").name, "system-7.wav");
});
