import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiClient, ApiError, apiUrl, audioUrl, eventsUrl, isLocalServer, normalizeServerUrl, originPattern, panelUrl,
  reportUrl, serverKind,
} from "../../lib/api.js";

test("normalizeServerUrl adds a scheme, trims slashes and rejects bad input", () => {
  assert.equal(normalizeServerUrl("127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.equal(normalizeServerUrl("  http://localhost:8000/  "), "http://localhost:8000");
  assert.equal(normalizeServerUrl("https://recapper.example.com///"), "https://recapper.example.com");
  assert.equal(normalizeServerUrl("https://example.com/recapper/"), "https://example.com/recapper");
  assert.equal(normalizeServerUrl("HTTP://LOCALHOST:8000"), "http://localhost:8000");
  for (const [input, code] of [["", "empty"], ["   ", "empty"], ["ftp://x.org", "scheme"], ["javascript:alert(1)", "invalid"],
    ["http://user:pw@host", "invalid"], ["http://host/?token=x", "invalid"], ["http://host/#x", "invalid"], ["http://", "invalid"]]) {
    assert.throws(() => normalizeServerUrl(input), (e) => e.code === code, `${JSON.stringify(input)} → ${code}`);
  }
});

test("local vs remote servers (host permissions)", () => {
  assert.equal(isLocalServer("http://127.0.0.1:8000"), true);
  assert.equal(isLocalServer("http://localhost:9000"), true);
  assert.equal(isLocalServer("http://[::1]:8000"), true);
  assert.equal(isLocalServer("http://192.168.1.10:8000"), false);
  assert.equal(isLocalServer("not a url"), false);
  assert.equal(serverKind("http://127.0.0.1:8000"), "local");
  assert.equal(serverKind("https://recapper.example.com"), "remote-https");
  assert.equal(serverKind("http://recapper.example.com"), "remote-http");
  assert.equal(originPattern("https://recapper.example.com:8443/base"), "https://recapper.example.com/*");
});

test("URL building encodes path and query parts", () => {
  assert.equal(apiUrl("http://h:1/", "/api/live"), "http://h:1/api/live");
  assert.equal(apiUrl("http://h:1", "api/live", { since: 5, x: undefined, y: null }), "http://h:1/api/live?since=5");
  assert.equal(audioUrl("http://h:1", "abc/../x"), "http://h:1/api/live/abc%2F..%2Fx/audio");
  assert.equal(eventsUrl("http://h:1", "s1", 12), "http://h:1/api/live/s1/events?since=12");
  assert.equal(reportUrl("http://127.0.0.1:8000/", "t o&k", "r1"), "http://127.0.0.1:8000/?token=t%20o%26k#/meeting/r1");
  assert.equal(reportUrl("https://h", "", "r1"), "https://h/#/meeting/r1");
  assert.equal(panelUrl("http://127.0.0.1:8000", "tok"), "http://127.0.0.1:8000/?token=tok&view=panel");
});

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const key = `${init.method || "GET"} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ detail: "не найдено" }), { status: 404 });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.http ? r.body : r), { status: r.http || 200 });
  };
  return { fetch, calls };
}

test("ApiClient sends the bearer token (except for /api/health) and JSON bodies", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /api/health": { status: "ok", mode: "sim-good" },
    "GET /api/settings": { values: { ui_language: "en" } },
    "POST /api/live": { id: "s1", mode: "sim-good" },
    "GET /api/live/s1/events": { events: [], last: 3, state: "open" },
    "POST /api/live/s1/ask": { id: "i1" },
    "POST /api/live/s1/items/i%201/answer": { id: "i 1" },
    "POST /api/live/s1/assist": { title: "Итог" },
    "POST /api/live/s1/finish": { id: "s1", state: "closing" },
  });
  const api = new ApiClient({ baseUrl: "http://127.0.0.1:8000/", token: "tok", fetch });
  assert.equal((await api.health()).mode, "sim-good");
  assert.equal(calls[0].init.headers.Authorization, undefined, "health is public");
  assert.equal((await api.settings()).values.ui_language, "en");
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok");
  assert.equal((await api.createLive({ title: "Встреча", template: "product" })).id, "s1");
  assert.deepEqual(JSON.parse(calls[2].init.body), { title: "Встреча", template: "product" });
  assert.equal(calls[2].init.headers["Content-Type"], "application/json");
  await api.events("s1", 3);
  assert.equal(calls[3].url, "http://127.0.0.1:8000/api/live/s1/events?since=3");
  await api.ask("s1", "Какие риски?");
  assert.deepEqual(JSON.parse(calls[4].init.body), { question: "Какие риски?" });
  await api.answerItem("s1", "i 1");
  await api.assist("s1", "summary");
  assert.deepEqual(JSON.parse(calls[6].init.body), { action: "summary" });
  assert.equal((await api.finish("s1")).state, "closing");
  assert.ok(calls.slice(1).every((c) => c.init.headers.Authorization === "Bearer tok"));
});

test("ApiClient maps HTTP and network failures to ApiError", async () => {
  const { fetch } = fakeFetch({
    "GET /api/settings": { http: 401, body: { detail: "invalid token" } },
    "POST /api/live": { http: 422, body: { detail: [{ msg: "too long" }] } },
    "GET /api/live": new TypeError("Failed to fetch"),
  });
  const api = new ApiClient({ baseUrl: "http://127.0.0.1:8000", token: "bad", fetch });
  await assert.rejects(api.settings(), (e) => e instanceof ApiError && e.status === 401 && e.code === "unauthorized" && e.detail === "invalid token");
  await assert.rejects(api.createLive({ title: "x" }), (e) => e.status === 422 && e.detail.includes("too long"));
  await assert.rejects(api.listLive(), (e) => e.status === 0 && e.code === "network");
  await assert.rejects(api.events("nope"), (e) => e.status === 404 && e.code === "not_found");
});

test("ApiClient times out", async () => {
  const fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const api = new ApiClient({ baseUrl: "http://127.0.0.1:8000", token: "t", fetch, timeoutMs: 20 });
  await assert.rejects(api.listLive(), (e) => e.code === "timeout");
});

test("createLive trims long titles and falls back to a default", async () => {
  const { fetch, calls } = fakeFetch({ "POST /api/live": { id: "s" } });
  const api = new ApiClient({ baseUrl: "http://h", token: "t", fetch });
  await api.createLive({ title: "x".repeat(300) });
  assert.equal(JSON.parse(calls[0].init.body).title.length, 200);
  await api.createLive({});
  assert.equal(JSON.parse(calls[1].init.body).title, "Встреча");
});
