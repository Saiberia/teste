/*
 * Recapper server API: URL building and a small client. Pure: `fetch` is
 * injected, no chrome.* APIs.
 */

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8000";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", detail = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code || (status ? `http_${status}` : "network");
    this.detail = detail;
  }
}

/**
 * Normalizes what the user typed into a base URL without a trailing slash.
 * "127.0.0.1:8000" → "http://127.0.0.1:8000"; only http(s), no credentials/query/hash.
 * @throws {Error} with `code` = "empty" | "invalid" | "scheme"
 */
export function normalizeServerUrl(input) {
  const raw = String(input ?? "").trim();
  const fail = (code) => Object.assign(new Error(`invalid server url: ${code}`), { code });
  if (!raw) throw fail("empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { throw fail("invalid"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw fail("scheme");
  if (!u.hostname || u.username || u.password || u.search || u.hash) throw fail("invalid");
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** True for servers on this computer (covered by the manifest's host_permissions). */
export function isLocalServer(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? LOCAL_HOSTS.has(u.hostname) : false;
  } catch { return false; }
}

/** Origin pattern for chrome.permissions.request, e.g. "https://recapper.example.com/*". */
export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

/**
 * Whether the extension can reach the server: local http(s) is always allowed,
 * remote servers only over https (optional host permission requested at runtime).
 * @returns {"local"|"remote-https"|"remote-http"}
 */
export function serverKind(baseUrl) {
  if (isLocalServer(baseUrl)) return "local";
  return new URL(baseUrl).protocol === "https:" ? "remote-https" : "remote-http";
}

/** `${base}${path}?query` with every query value URL-encoded; undefined/null values are skipped. */
export function apiUrl(baseUrl, path, query) {
  const base = String(baseUrl).replace(/\/+$/, "");
  let url = base + (path.startsWith("/") ? path : `/${path}`);
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }
  return url;
}

export const livePath = (sid, rest = "") => `/api/live/${encodeURIComponent(sid)}${rest}`;
export const audioUrl = (baseUrl, sid) => apiUrl(baseUrl, livePath(sid, "/audio"));
export const eventsUrl = (baseUrl, sid, since = 0) => apiUrl(baseUrl, livePath(sid, "/events"), { since });

/** Link to the finished meeting's report in the server's web UI. */
export function reportUrl(baseUrl, token, meetingId) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${base}/${q}#/meeting/${encodeURIComponent(meetingId)}`;
}

/** The server web UI's compact panel (attaches to the newest open session). */
export function panelUrl(baseUrl, token) {
  return apiUrl(baseUrl, "/", token ? { token, view: "panel" } : { view: "panel" });
}

async function errorFrom(res) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      detail = typeof body?.detail === "string" ? body.detail : body?.detail ? JSON.stringify(body.detail) : text;
    } catch { detail = text; }
  } catch { /* ignore */ }
  const code = { 401: "unauthorized", 404: "not_found", 409: "session_closed", 503: "asr_unavailable" }[res.status];
  return new ApiError(detail || `HTTP ${res.status}`, { status: res.status, code, detail: String(detail).slice(0, 500) });
}

export class ApiClient {
  /** @param {{baseUrl: string, token?: string, fetch?: Function, timeoutMs?: number}} o */
  constructor({ baseUrl, token = "", fetch: fetchImpl, timeoutMs = 15000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  headers(json = false) {
    const h = {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async request(method, path, { query, body, auth = true, timeoutMs } = {}) {
    const url = apiUrl(this.baseUrl, path, query);
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs) : null;
    const headers = auth ? this.headers(body !== undefined) : body !== undefined ? { "Content-Type": "application/json" } : {};
    let res;
    try {
      res = await this.fetch(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl?.signal,
      });
    } catch (e) {
      const aborted = e?.name === "AbortError";
      throw new ApiError(aborted ? "timeout" : String(e?.message || e), { status: 0, code: aborted ? "timeout" : "network" });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw await errorFrom(res);
    const text = await res.text();
    try { return text ? JSON.parse(text) : null; } catch { throw new ApiError("invalid JSON", { status: res.status, code: "bad_json" }); }
  }

  health() { return this.request("GET", "/api/health", { auth: false }); }
  settings() { return this.request("GET", "/api/settings"); }
  meta() { return this.request("GET", "/api/meta"); }
  listLive() { return this.request("GET", "/api/live"); }
  createLive({ title, template, autoAnswer } = {}) {
    const body = { title: String(title || "").slice(0, 200) || "Встреча" };
    if (template) body.template = template;
    if (autoAnswer) body.auto_answer = autoAnswer;
    return this.request("POST", "/api/live", { body });
  }
  events(sid, since = 0) { return this.request("GET", livePath(sid, "/events"), { query: { since } }); }
  ask(sid, question) { return this.request("POST", livePath(sid, "/ask"), { body: { question } }); }
  answerItem(sid, itemId) {
    return this.request("POST", livePath(sid, `/items/${encodeURIComponent(itemId)}/answer`), { body: {} });
  }
  assist(sid, action) { return this.request("POST", livePath(sid, "/assist"), { body: { action }, timeoutMs: 120000 }); }
  finish(sid) { return this.request("POST", livePath(sid, "/finish"), { body: {} }); }
}
