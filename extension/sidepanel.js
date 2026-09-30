/*
 * Side panel UI: server connection, meeting session, audio capture controls
 * and the live results (my tasks, heard suggestions, quick actions, ask box,
 * finish → report link). Pure logic lives in lib/; this file wires it to the
 * DOM and chrome.* APIs. The only innerHTML assignment is renderMarkdown()
 * output (escaped).
 */

import {
  ApiClient, DEFAULT_SERVER_URL, normalizeServerUrl, originPattern, panelUrl, reportUrl, serverKind,
} from "./lib/api.js";
import { resolveCaptureOptions, selectedSources } from "./lib/capture-config.js";
import { makeT } from "./lib/i18n.js";
import { renderMarkdown, safeHttpUrl } from "./lib/md.js";
import {
  clearPending, formatClock, initialState, markAssistPending, markRequested, reduceEvents, selectView,
} from "./lib/reducer.js";

const POLL_MS = 1200;
const POLL_BACKOFF_MS = 4000;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const FIXED_TAB = Number(params.get("tab")) || null; // popup-window mode (and tests): the meeting tab

const UI = {
  t: makeT("ru"),
  config: { serverUrl: DEFAULT_SERVER_URL, token: "" },
  api: null,
  conn: "none", // none | checking | ok | fail
  health: null,
  values: null, // GET /api/settings → values
  meta: null,
  session: null, // {id, title, finished?, reportId?, recap?}
  ev: initialState(null),
  lost: false,
  finishing: false,
  pollTimer: null,
  polling: false,
  pollAgain: false,
  capture: { state: "idle" },
  captureBusy: false,
  captureWarnings: [],
  levels: {},
  targetTab: null,
  mic: "unknown",
  renderedKey: "",
};
const t = (key, vars) => UI.t(key, vars);

// ---------------------------------------------------------------- helpers ---
function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

function applyI18n() {
  document.documentElement.lang = UI.t.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  $("assist-result").dataset.empty = t("assist_empty");
  $("token-toggle").textContent = $("token").type === "password" ? t("show") : t("hide");
}

function setLanguage(lang) {
  const next = makeT(lang);
  if (next.lang === UI.t.lang) return;
  UI.t = next;
  chrome.storage.local.set({ lang: next.lang }).catch(() => {});
  applyI18n();
  UI.renderedKey = "";
  renderAll();
}

function toast(message, kind = "info", ms = 4500) {
  const el = h("div", { class: `toast ${kind === "err" ? "err" : ""}`, role: kind === "err" ? "alert" : "status" }, message);
  $("toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

function showBanner(message) {
  $("banner-text").textContent = message;
  $("banner").hidden = false;
}
function hideBanner() { $("banner").hidden = true; }

function describeApiError(e) {
  if (!e) return t("err_generic", { message: "?" });
  if (e.status === 401) return t("err_unauthorized");
  if (e.code === "network") return t("err_network", { url: UI.config.serverUrl });
  if (e.code === "timeout") return t("err_timeout");
  return t("err_generic", { message: e.detail || e.message || String(e) });
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage({ ...message, target: "background" });
  } catch (e) {
    return { ok: false, error: { code: "runtime", message: String(e?.message || e) } };
  }
}

// ------------------------------------------------------------ connection ---
function makeApi() {
  UI.api = new ApiClient({ baseUrl: UI.config.serverUrl, token: UI.config.token });
}

async function connect() {
  if (!UI.config.serverUrl || !UI.config.token) {
    UI.conn = "none";
    renderConn();
    return false;
  }
  makeApi();
  UI.conn = "checking";
  renderConn();
  const result = $("conn-result");
  try {
    const health = await UI.api.health();
    const settings = await UI.api.settings();
    UI.health = health;
    UI.values = settings?.values || {};
    setLanguage(UI.values.ui_language);
    try { UI.meta = await UI.api.meta(); } catch { UI.meta = null; }
    UI.conn = "ok";
    result.className = "result ok";
    result.textContent = t("conn_result", {
      version: health.version || "?",
      mode: health.mode === "offline" ? t("mode_offline") : health.mode || "?",
      asr: health.asr || "?",
    });
    $("asr-warning").hidden = health.asr !== "none";
    return true;
  } catch (e) {
    UI.conn = "fail";
    result.className = "result fail";
    result.textContent = describeApiError(e);
    $("asr-warning").hidden = true;
    return false;
  } finally {
    renderTemplates();
    renderAssistActions();
    renderAll();
  }
}

function renderConn() {
  const chip = $("conn");
  const map = {
    none: ["", t("conn_none")],
    checking: ["", t("conn_checking")],
    ok: ["ok", `${t("conn_ok")} · ${UI.health?.mode === "offline" ? t("mode_offline") : UI.health?.mode || ""}`],
    fail: ["fail", t("conn_fail")],
  };
  const [cls, text] = map[UI.conn] || map.none;
  chip.className = `chip ${cls}`;
  chip.textContent = text;
  chip.title = UI.config.serverUrl;
  $("open-web").href = UI.config.serverUrl ? `${UI.config.serverUrl}/${UI.config.token ? `?token=${encodeURIComponent(UI.config.token)}` : ""}` : "#";
}

async function onSaveSettings() {
  const raw = $("server-url").value;
  const token = $("token").value.trim();
  const result = $("conn-result");
  let url;
  try {
    url = normalizeServerUrl(raw);
  } catch (e) {
    result.className = "result fail";
    result.textContent = t({ empty: "err_url_empty", scheme: "err_url_scheme" }[e.code] || "err_url_invalid");
    return;
  }
  const kind = serverKind(url);
  if (kind === "remote-http") {
    result.className = "result fail";
    result.textContent = t("err_url_http_remote");
    return;
  }
  if (kind === "remote-https") {
    // Needs the click's user activation, so it is the first await of the handler.
    const origin = originPattern(url);
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [origin] }); } catch { granted = false; }
    if (!granted) {
      result.className = "result fail";
      result.textContent = t("err_permission_denied", { origin });
      return;
    }
  }
  UI.config = { serverUrl: url, token };
  $("server-url").value = url;
  await chrome.storage.local.set({ serverUrl: url, token });
  toast(t("saved"));
  const ok = await connect();
  if (ok) await refreshSessions();
}

async function onTestConnection() {
  const ok = await connect();
  if (ok && !UI.session) await refreshSessions();
}

// --------------------------------------------------------------- mic permission ---
async function refreshMicPermission() {
  document.body.dataset.micChecks = String(Number(document.body.dataset.micChecks || 0) + 1);
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    UI.mic = status.state;
    status.onchange = () => { UI.mic = status.state; renderMic(); };
  } catch {
    UI.mic = "unknown";
  }
  renderMic();
}

function renderMic() {
  $("mic-state").textContent = t(`mic_${["granted", "prompt", "denied"].includes(UI.mic) ? UI.mic : "unknown"}`);
  $("mic-state").dataset.state = UI.mic;
  $("mic-grant").hidden = UI.mic === "granted";
}

// ------------------------------------------------------------------ target tab ---
async function resolveTargetTab(tabId) {
  const id = tabId || FIXED_TAB;
  if (id) {
    try { return await chrome.tabs.get(id); } catch { /* closed */ }
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function refreshTargetTab(tabId) {
  UI.targetTab = await resolveTargetTab(tabId);
  let title = UI.targetTab?.title || "";
  if (!title && UI.targetTab) {
    try {
      const { invokedTab } = await chrome.storage.session.get("invokedTab");
      if (invokedTab?.id === UI.targetTab.id) title = invokedTab.title || "";
    } catch { /* ignore */ }
  }
  UI.targetTitle = title;
  renderTargetTab();
}

function renderTargetTab() {
  const title = UI.targetTitle;
  $("target-tab").textContent = UI.targetTab ? t("target_tab", { title: title || `#${UI.targetTab.id}` }) : t("target_tab_unknown");
  $("new-title").placeholder = title || t("default_title");
}

/** List entries from the server/AI, minus empty ones (a model may return null items). */
const cleanList = (list) => (Array.isArray(list) ? list : []).filter((x) => x !== null && x !== undefined && String(x).trim());

// -------------------------------------------------------------------- sessions ---
async function refreshSessions() {
  if (!UI.api) return;
  const select = $("session-select");
  let list = [];
  try { list = await UI.api.listLive(); } catch (e) { toast(describeApiError(e), "err"); }
  select.replaceChildren();
  const open = (list || []).filter((s) => s.state === "open");
  if (!open.length) {
    select.append(h("option", { value: "" }, t("no_open_sessions")));
    select.disabled = true;
    $("attach").disabled = true;
    return;
  }
  for (const s of open) {
    const time = (s.created_at || "").slice(11, 16);
    select.append(h("option", { value: s.id, "data-title": s.title }, `${s.title}${time ? ` · ${time}` : ""}`));
  }
  select.disabled = false;
  $("attach").disabled = false;
}

function renderTemplates() {
  const select = $("template");
  const templates = UI.meta?.templates || [];
  const current = select.value || UI.values?.default_template || "general";
  select.replaceChildren(...templates.map((tpl) => h("option", { value: tpl.id }, tpl.name)));
  if (!templates.length) select.append(h("option", { value: "" }, "—"));
  select.value = templates.some((x) => x.id === current) ? current : templates[0]?.id || "";
}

async function onCreateSession() {
  if (!UI.api) { toast(t("err_not_configured"), "err"); return; }
  const title = $("new-title").value.trim() || UI.targetTitle || t("default_title");
  const btn = $("create-session");
  btn.disabled = true;
  try {
    const r = await UI.api.createLive({ title, template: $("template").value || undefined });
    $("new-title").value = "";
    await attach({ id: r.id, title });
  } catch (e) {
    toast(describeApiError(e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function onAttach() {
  const select = $("session-select");
  const opt = select.selectedOptions[0];
  if (!opt || !opt.value) return;
  await attach({ id: opt.value, title: opt.dataset.title || opt.textContent });
}

async function attach(session) {
  stopPolling();
  UI.session = { id: session.id, title: session.title };
  UI.ev = initialState(session.id);
  UI.lost = false;
  UI.finishing = false;
  $("consent").checked = false;
  hideBanner();
  await chrome.storage.local.set({ attached: UI.session });
  renderAll();
  startPolling();
}

async function onDetach() {
  if (isCapturing()) await stopCapture();
  stopPolling();
  UI.session = null;
  UI.ev = initialState(null);
  UI.lost = false;
  UI.finishing = false;
  await chrome.storage.local.remove("attached");
  hideBanner();
  renderAll();
  await refreshSessions();
}

// --------------------------------------------------------------------- polling ---
function startPolling() {
  stopPolling();
  UI.pollTimer = setTimeout(pollOnce, 0);
}

function stopPolling() {
  if (UI.pollTimer) clearTimeout(UI.pollTimer);
  UI.pollTimer = null;
}

function pollNow() {
  if (!UI.session || UI.session.finished || UI.lost) return;
  if (UI.polling) { UI.pollAgain = true; return; }
  stopPolling();
  pollOnce();
}

async function pollOnce() {
  UI.pollTimer = null;
  const session = UI.session;
  if (!session || session.finished || UI.lost || !UI.api) return;
  UI.polling = true;
  let delay = POLL_MS;
  try {
    const r = await UI.api.events(session.id, UI.ev.last);
    if (UI.session !== session) return;
    UI.ev = reduceEvents(UI.ev, r);
    if (UI.conn !== "ok") { UI.conn = "ok"; renderConn(); }
    renderResults();
    if (UI.ev.doneId) { onDone(); return; }
  } catch (e) {
    if (UI.session !== session) return;
    if (e.status === 404) { onSessionLost(); return; }
    if (e.status === 401) showBanner(t("err_unauthorized"));
    UI.conn = "fail";
    renderConn();
    delay = POLL_BACKOFF_MS;
  } finally {
    UI.polling = false;
    if (UI.session === session && !session.finished && !UI.lost) {
      UI.pollTimer = setTimeout(pollOnce, UI.pollAgain ? 0 : delay);
      UI.pollAgain = false;
    }
  }
}

function onSessionLost() {
  UI.lost = true;
  stopPolling();
  showBanner(t("session_lost"));
  if (isCapturing()) stopCapture();
  renderAll();
}

async function onDone() {
  stopPolling();
  UI.finishing = false;
  UI.session = { ...UI.session, finished: true, reportId: UI.ev.doneId, recap: UI.ev.recap };
  await chrome.storage.local.set({ attached: UI.session });
  if (isCapturing()) await stopCapture({ flush: false });
  renderAll();
}

// --------------------------------------------------------------------- capture ---
function isCapturing() {
  return ["starting", "running", "stopping"].includes(UI.capture?.state);
}

async function refreshCaptureStatus() {
  const res = await send({ type: "capture-status" });
  if (res?.status) UI.capture = res.status;
  renderCapture();
}

function tabCaptureWarning(err) {
  const message = String(err?.message || err || "");
  if (/invoked|activeTab/i.test(message)) return { code: "tab_capture_invoke", source: "system", message };
  if (/chrome pages|cannot be captured|chrome:\/\//i.test(message)) return { code: "tab_capture_chrome_page", source: "system", message };
  return { code: "tab_capture_failed", source: "system", message };
}

async function onStartCapture() {
  hideBanner();
  if (!UI.session || UI.session.finished) return;
  if (!$("consent").checked) {
    UI.captureWarnings = [{ code: "consent_needed" }];
    renderCapture();
    $("consent").focus();
    return;
  }
  const wanted = selectedSources({ tab: $("src-tab").checked, mic: $("src-mic").checked });
  if (!wanted.length) {
    UI.captureWarnings = [{ code: "no_sources_selected" }];
    renderCapture();
    return;
  }
  UI.captureBusy = true;
  UI.captureWarnings = [];
  UI.capture = { state: "starting" };
  renderCapture();
  const warnings = [];
  let streamId = null;
  if (wanted.includes("system")) {
    try {
      // Called straight from the click; works once the extension was invoked on the tab (activeTab).
      const tab = UI.targetTab || (await resolveTargetTab());
      if (!tab) throw new Error("no tab");
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      warnings.push(tabCaptureWarning(e));
    }
  }
  const sources = wanted.filter((s) => s !== "system" || streamId);
  if (!sources.length) {
    UI.captureBusy = false;
    UI.capture = { state: "idle" };
    UI.captureWarnings = warnings;
    renderCapture();
    return;
  }
  const opts = resolveCaptureOptions(UI.values);
  const res = await send({
    type: "capture-start",
    options: {
      sessionId: UI.session.id,
      serverUrl: UI.config.serverUrl,
      token: UI.config.token,
      sources,
      streamId,
      chunkSeconds: opts.chunkSeconds,
      silenceThreshold: opts.silenceThreshold,
    },
  });
  UI.captureBusy = false;
  if (res?.status) UI.capture = res.status;
  else if (!res?.ok) UI.capture = { state: "idle" };
  const fromOffscreen = res?.status?.warnings || res?.error?.warnings || [];
  UI.captureWarnings = warnings.concat(fromOffscreen);
  if (!res?.ok) {
    const code = res?.error?.code || "no_sources";
    if (code !== "no_sources" || !fromOffscreen.length) {
      UI.captureWarnings.push({ code: code === "no_sources" ? "no_sources" : "error", message: res?.error?.message || code });
    } else {
      UI.captureWarnings.push({ code: "no_sources" });
    }
  }
  renderCapture();
}

async function stopCapture({ flush = true } = {}) {
  UI.captureBusy = true;
  renderCapture();
  const res = await send({ type: "capture-stop", flush });
  UI.captureBusy = false;
  UI.capture = res?.status || { state: "idle" };
  renderCapture();
}

function onCaptureEvent(ev) {
  if (!ev) return;
  if (ev.kind === "state") {
    UI.capture = ev.status || { state: "idle" };
    if (ev.status?.state === "stopped" && ev.status.fatal && $("banner").hidden) {
      showBanner(t(`upload_${ev.status.fatal}`, { detail: "" }).trim());
    }
    renderCapture();
  } else if (ev.kind === "uploaded") {
    const src = UI.capture?.sources?.[ev.source];
    if (src) src.sent = (src.sent || 0) + 1;
    renderCapture();
    pollNow();
  } else if (ev.kind === "upload-error") {
    if (ev.fatal) {
      showBanner(t(`upload_${ev.code}`, { detail: ev.detail || "" }).trim());
    } else if (ev.code === "network") {
      toast(t("upload_network", { source: t(`src_name_${ev.source}`) }), "err");
    } else {
      toast(t("upload_http", { source: t(`src_name_${ev.source}`), detail: ev.detail || `HTTP ${ev.status}` }), "err");
    }
  } else if (ev.kind === "warning") {
    UI.captureWarnings = UI.captureWarnings.concat([{ code: ev.code, source: ev.source }]);
    renderCapture();
  } else if (ev.kind === "levels") {
    UI.levels = ev.levels || {};
    renderMeters();
  }
}

function warningText(w) {
  switch (w.code) {
    case "consent_needed": return t("consent_needed");
    case "no_sources_selected": return t("no_sources_selected");
    case "tab_capture_invoke": return t("tab_capture_invoke");
    case "tab_capture_chrome_page": return t("tab_capture_chrome_page");
    case "tab_capture_failed":
    case "system_unavailable": return t("tab_capture_failed", { message: w.message || "" });
    case "mic_permission": return t("mic_permission");
    case "mic_unavailable": return t("mic_failed", { message: w.message || "" });
    case "no_sources": return t("no_sources");
    case "queue_overflow": return t("queue_overflow");
    case "track_ended_system": return t("track_ended_system");
    case "track_ended_mic": return t("track_ended_mic");
    default: return t("err_generic", { message: w.message || w.code });
  }
}

function renderCapture() {
  const s = UI.session;
  const running = isCapturing();
  // Hidden once the meeting is over, unless a capture is still active (so it can be stopped).
  $("capture").hidden = !(s && !s.finished && !UI.lost) && !running;
  const state = UI.capture?.state || "idle";
  $("start-capture").hidden = running;
  $("stop-capture").hidden = !running;
  $("start-capture").disabled = UI.captureBusy;
  $("stop-capture").disabled = UI.captureBusy || state === "stopping" || state === "starting";
  $("src-tab").disabled = running;
  $("src-mic").disabled = running;
  const status = $("capture-status");
  const sources = UI.capture?.sources || {};
  const on = Object.entries(sources).filter(([, v]) => v.state === "on").map(([k]) => k);
  if (state === "starting") status.textContent = t("starting");
  else if (state === "stopping") status.textContent = t("stopping");
  else if (state === "running") {
    const sent = Object.values(sources).reduce((a, v) => a + (v.sent || 0), 0);
    const skipped = Object.values(sources).reduce((a, v) => a + (v.skipped || 0), 0);
    status.textContent = `${t("recording", { sources: on.map((k) => t(`src_name_${k}`)).join(" + ") })} · ${t("sent_chunks", { n: sent })}${skipped ? ` · ${t("skipped_chunks", { n: skipped })}` : ""}`;
  } else status.textContent = state === "stopped" ? t("capture_stopped") : t("not_recording");
  status.className = `result ${state === "running" ? "ok" : ""}`;
  status.dataset.state = state;
  status.dataset.sources = JSON.stringify(Object.fromEntries(Object.entries(sources)
    .map(([k, v]) => [k, { state: v.state, playback: Boolean(v.playback) }])));
  // Which sources failed and why; "continuing with the other one".
  const warnings = [...UI.captureWarnings];
  if (running && on.length === 1 && warnings.some((w) => w.source && w.source !== on[0])) {
    warnings.push({ code: on[0] === "mic" ? "only_mic_note" : "only_tab_note" });
  }
  $("capture-warnings").replaceChildren(...warnings.map((w) => h("li", { "data-code": w.code },
    w.code === "only_mic_note" ? t("only_mic") : w.code === "only_tab_note" ? t("only_tab") : warningText(w))));
  renderMeters();
}

function renderMeters() {
  const box = $("meters");
  const sources = UI.capture?.sources || {};
  const on = Object.entries(sources).filter(([, v]) => v.state === "on").map(([k]) => k);
  if (!isCapturing() || !on.length) { box.replaceChildren(); return; }
  box.replaceChildren(...on.map((k) => {
    const level = Math.min(1, Math.sqrt(UI.levels[k] || 0) * 2.2); // perceptual-ish scale
    return h("div", { class: "meter", "data-source": k }, t(`src_name_${k}`),
      h("span", { class: "bar" }, h("i", { style: `width:${Math.round(level * 100)}%` })));
  }));
}

// --------------------------------------------------------------------- results ---
function chip(text, cls = "") { return h("span", { class: `chip ${cls}` }, text); }

function renderAnswer(a, id) {
  const box = h("div", { class: "answer" });
  const statusKey = { draft: "status_draft", needs_llm: "status_needs_llm", failed: "status_failed" }[a.status] || "status_draft";
  const copy = h("button", {
    type: "button", class: "btn ghost small",
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText([a.summary, a.body].filter(Boolean).join("\n\n"));
        e.target.textContent = t("copied");
      } catch { /* clipboard not available */ }
    },
  }, t("copy"));
  box.append(h("div", { class: "answer-head" },
    chip(t(statusKey), `st-${a.status}`),
    a.confidence ? h("span", { class: "muted" }, `${t("confidence")}: ${["high", "medium", "low"].includes(a.confidence) ? t(`conf_${a.confidence}`) : a.confidence}`) : null,
    copy));
  if (a.summary) {
    const sum = h("div", { class: "summary md" });
    sum.innerHTML = renderMarkdown(a.summary); // escaped; see lib/md.js
    box.append(sum);
  }
  if (a.body) {
    const body = h("div", { class: "md" });
    body.innerHTML = renderMarkdown(a.body); // escaped; see lib/md.js
    box.append(body);
  }
  if (a.assumptions?.length) {
    box.append(h("details", { class: "assumptions" }, h("summary", {}, t("assumptions")),
      h("ul", {}, a.assumptions.map((x) => h("li", {}, String(x))))));
  }
  if (a.sources?.length) {
    box.append(h("details", { class: "sources", open: true }, h("summary", {}, t("sources")),
      h("ul", {}, a.sources.map((src) => {
        const title = typeof src === "string" ? src : src.title || src.ref || "";
        const ref = typeof src === "string" ? src : src.ref || "";
        const url = safeHttpUrl(ref);
        return h("li", {}, url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, title || url) : `${title}${ref && ref !== title ? ` (${ref})` : ""}`);
      }))));
  }
  if (a.warnings?.length) {
    box.append(h("details", { class: "ai-warnings" }, h("summary", {}, t("ai_check_warn")),
      h("ul", {}, a.warnings.map((x) => h("li", {}, String(x))))));
  }
  box.dataset.itemId = id;
  return box;
}

function renderCard(card, { heard, finished }) {
  const { item, answer, status } = card;
  const meta = h("div", { class: "meta" },
    chip(t(item.kind === "task" ? "kind_task" : "kind_question")),
    item.origin === "voice" ? chip(t("by_voice")) : item.origin === "user" ? chip(t("typed")) : null,
    item.speaker ? h("span", { class: "speaker" }, item.speaker) : null,
    item.start !== null && item.start !== undefined ? h("span", { class: "time" }, formatClock(item.start)) : null);
  const el = h("article", { class: `item st-card-${status}`, "data-id": item.id, "data-status": status }, meta,
    h("p", { class: "text" }, item.text || ""));
  if (item.quote && item.quote !== item.text) el.append(h("blockquote", { class: "quote" }, `«${item.quote}»`));
  if (answer) el.append(renderAnswer(answer, item.id));
  else if (status === "pending") {
    const stage = card.stage && t(`stage_${card.stage}`) !== `stage_${card.stage}` ? ` (${t(`stage_${card.stage}`)})` : "";
    el.append(h("p", { class: "pending" }, h("span", { class: "spinner", "aria-hidden": "true" }), `${t("answering")}${stage}`));
  }
  else if (status === "limit") el.append(h("p", { class: "pending" }, t("status_limit")));
  else if (status === "unanswered") el.append(h("p", { class: "pending" }, t("status_unanswered")));
  else if (heard && !finished) {
    el.append(h("button", { type: "button", class: "btn small answer-btn", onclick: () => onAnswerItem(item.id) }, t("answer")));
  }
  return el;
}

function renderResults() {
  const s = UI.session;
  const show = Boolean(s);
  $("tasks").hidden = !show;
  $("heard").hidden = !show;
  $("assist").hidden = !show || Boolean(s?.finished) || UI.lost;
  $("askbar").hidden = !show || Boolean(s?.finished) || UI.lost || !$("view-web").hidden;
  $("finish").hidden = !show || UI.lost;
  if (!show) return;
  const view = selectView(UI.ev);
  const key = JSON.stringify([UI.t.lang, UI.ev.last, UI.ev.requested, UI.ev.assistPending, Boolean(s.finished), UI.finishing]);
  if (key !== UI.renderedKey) {
    UI.renderedKey = key;
    const finished = view.finished || Boolean(s.finished);
    $("tasks-list").replaceChildren(...(view.tasks.length
      ? view.tasks.map((c) => renderCard(c, { heard: false, finished }))
      : [h("p", { class: "muted small empty" }, t("no_tasks"))]));
    $("heard-list").replaceChildren(...(view.heard.length
      ? view.heard.map((c) => renderCard(c, { heard: true, finished }))
      : [h("p", { class: "muted small empty" }, t("no_heard"))]));
    $("tasks-count").textContent = view.tasks.length ? `(${view.tasks.length})` : "";
    $("heard-count").textContent = view.heard.length ? `(${view.heard.length})` : "";
    renderAssistResult(view);
    view.errors.slice(-1).forEach((err) => {
      if (err.seq > (UI.lastErrorSeq || 0)) {
        UI.lastErrorSeq = err.seq;
        toast(`${t("server_error", { message: err.message })}${err.retry ? ` (${t("retry_soon")})` : ""}`, "err");
      }
    });
  }
  renderFinish(view);
}

function renderAssistActions() {
  const box = $("assist-actions");
  const all = UI.meta?.assist_actions || [];
  const enabled = Array.isArray(UI.values?.assist_actions) ? UI.values.assist_actions : null;
  const actions = enabled ? all.filter((a) => enabled.includes(a.id)) : all;
  box.replaceChildren(...actions.map((a) => h("button", {
    type: "button", class: "btn small", "data-action": a.id, onclick: () => onAssist(a.id),
  }, a.title)));
}

function renderAssistResult(view) {
  const box = $("assist-result");
  if (view.assistPending) {
    box.replaceChildren(h("p", { class: "pending" }, h("span", { class: "spinner", "aria-hidden": "true" }), t("answering")));
    return;
  }
  const a = view.assist;
  if (!a) { box.replaceChildren(); return; }
  const bullets = cleanList(a.bullets);
  box.replaceChildren(
    h("h3", {}, a.title || a.action || ""),
    a.text ? h("p", {}, a.text) : null,
    bullets.length ? h("ul", {}, bullets.map((b) => h("li", {}, String(b)))) : null);
}

function renderRecap(recap) {
  const box = $("recap");
  if (!recap) { box.replaceChildren(); return; }
  const parts = [h("h3", {}, t("recap"))];
  if (recap.summary) parts.push(h("p", { class: "recap-summary" }, recap.summary));
  for (const sec of recap.sections || []) {
    const bullets = cleanList(sec?.bullets);
    if (!bullets.length) continue;
    parts.push(h("h4", {}, sec.title), h("ul", {}, bullets.map((b) => h("li", {}, String(b)))));
  }
  const decisions = cleanList(recap.decisions);
  if (decisions.length) parts.push(h("h4", {}, t("decisions")), h("ul", {}, decisions.map((d) => h("li", {}, String(d)))));
  const actions = (recap.action_items || []).filter((a) => a?.text);
  if (actions.length) {
    parts.push(h("h4", {}, t("action_items")), h("ul", {}, actions.map((a) =>
      h("li", {}, [a.text, a.owner, a.due].filter(Boolean).join(" — ")))));
  }
  box.replaceChildren(...parts);
}

function renderFinish(view) {
  const s = UI.session;
  if (!s) return;
  const finished = Boolean(s.finished) || view.finished;
  const closing = !finished && (UI.finishing || view.closing);
  $("finish-btn").hidden = finished || closing;
  if (finished || closing) $("finish-confirm").hidden = true;
  $("finishing").hidden = !closing;
  $("done-card").hidden = !finished;
  if (finished) {
    const id = s.reportId || view.doneId;
    $("report-link").href = reportUrl(UI.config.serverUrl, UI.config.token, id);
    renderRecap(s.recap || view.recap);
  }
}

function renderMeeting() {
  const s = UI.session;
  $("meeting-pick").hidden = Boolean(s) || UI.conn === "none";
  $("meeting-current").hidden = !s;
  if (!s) return;
  $("meeting-title").textContent = s.title || "";
  const state = s.finished ? "finished" : UI.finishing ? "closing" : UI.ev.serverState || "open";
  const chipEl = $("meeting-state");
  chipEl.textContent = t(`state_${state}`) || state;
  chipEl.className = `chip ${state === "open" ? "ok" : state === "closing" ? "warn" : ""}`;
  chipEl.dataset.state = state;
}

function renderAll() {
  renderConn();
  renderMeeting();
  renderTargetTab();
  renderCapture();
  renderResults();
  renderMic();
}

// --------------------------------------------------------------------- actions ---
async function onAnswerItem(itemId) {
  if (!UI.session) return;
  UI.ev = markRequested(UI.ev, itemId);
  renderResults();
  try {
    await UI.api.answerItem(UI.session.id, itemId);
    pollNow();
  } catch (e) {
    UI.ev = clearPending(UI.ev, { itemId });
    renderResults();
    toast(describeApiError(e), "err");
  }
}

async function onAssist(action) {
  if (!UI.session) return;
  UI.ev = markAssistPending(UI.ev, action);
  renderResults();
  try {
    await UI.api.assist(UI.session.id, action);
    pollNow();
  } catch (e) {
    UI.ev = clearPending(UI.ev, { assist: true });
    renderResults();
    toast(describeApiError(e), "err");
  }
}

async function onAsk(e) {
  e.preventDefault();
  if (!UI.session) return;
  const input = $("ask-input");
  const q = input.value.trim();
  if (q.length < 2) { toast(t("ask_too_short"), "err"); return; }
  $("ask-btn").disabled = true;
  try {
    await UI.api.ask(UI.session.id, q);
    input.value = "";
    pollNow();
  } catch (err) {
    toast(describeApiError(err), "err");
  } finally {
    $("ask-btn").disabled = false;
  }
}

async function onFinish() {
  if (!UI.session) return;
  $("finish-confirm").hidden = true;
  UI.finishing = true;
  renderAll();
  if (isCapturing()) await stopCapture({ flush: true }); // the last words still reach the report
  try {
    await UI.api.finish(UI.session.id);
    pollNow();
  } catch (e) {
    UI.finishing = false;
    renderAll();
    if (e.status === 404) onSessionLost();
    else toast(describeApiError(e), "err");
  }
}

/**
 * Opens the report link (<server>/?token=…#/meeting/<id>) in a new tab. The server web UI removes
 * ?token= from the address bar with history.replaceState and currently drops the #/meeting/<id>
 * hash with it, landing on the live view; so once the page has loaded we re-apply the hash
 * (a same-document navigation → the UI routes to the report). With a fixed UI this is a no-op.
 */
async function openReport(event) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; // let the browser handle it
  event.preventDefault();
  const id = UI.session?.reportId || UI.ev.doneId;
  if (!id) return;
  const url = reportUrl(UI.config.serverUrl, UI.config.token, id);
  const hashUrl = `${UI.config.serverUrl}/#/meeting/${encodeURIComponent(id)}`;
  const tab = await chrome.tabs.create({ url });
  const onUpdated = (tabId, info) => {
    if (tabId !== tab.id || info.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.update(tab.id, { url: hashUrl }).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 30000);
}

function switchTab(name) {
  const web = name === "web";
  $("tab-assistant").setAttribute("aria-selected", String(!web));
  $("tab-web").setAttribute("aria-selected", String(web));
  $("view-assistant").hidden = web;
  $("view-web").hidden = !web;
  $("askbar").hidden = web || !UI.session || Boolean(UI.session?.finished) || UI.lost;
  if (web) {
    const src = UI.config.serverUrl ? panelUrl(UI.config.serverUrl, UI.config.token) : "about:blank";
    const frame = $("web-frame");
    if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
  }
}

// ------------------------------------------------------------------------ init ---
function bind() {
  $("settings-toggle").addEventListener("click", () => {
    const open = $("settings").hidden;
    $("settings").hidden = !open;
    $("settings-toggle").setAttribute("aria-expanded", String(open));
  });
  $("token-toggle").addEventListener("click", () => {
    const input = $("token");
    input.type = input.type === "password" ? "text" : "password";
    $("token-toggle").textContent = input.type === "password" ? t("show") : t("hide");
  });
  $("save-settings").addEventListener("click", onSaveSettings);
  $("test-conn").addEventListener("click", onTestConnection);
  $("mic-grant").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") }));
  $("refresh-sessions").addEventListener("click", refreshSessions);
  $("attach").addEventListener("click", onAttach);
  $("create-session").addEventListener("click", onCreateSession);
  $("detach").addEventListener("click", onDetach);
  $("start-capture").addEventListener("click", onStartCapture);
  $("stop-capture").addEventListener("click", () => stopCapture({ flush: true }));
  $("consent").addEventListener("change", () => {
    UI.captureWarnings = UI.captureWarnings.filter((w) => w.code !== "consent_needed");
    renderCapture();
  });
  $("ask-form").addEventListener("submit", onAsk);
  $("finish-btn").addEventListener("click", () => { $("finish-confirm").hidden = false; });
  $("finish-cancel").addEventListener("click", () => { $("finish-confirm").hidden = true; });
  $("finish-yes").addEventListener("click", onFinish);
  $("new-after-done").addEventListener("click", onDetach);
  $("report-link").addEventListener("click", openReport);
  $("banner-close").addEventListener("click", hideBanner);
  $("tab-assistant").addEventListener("click", () => switchTab("assistant"));
  $("tab-web").addEventListener("click", () => switchTab("web"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "capture-event") onCaptureEvent(msg.event);
    else if (msg?.type === "invoked-tab") refreshTargetTab(msg.tabId);
    else if (msg?.type === "mic-permission") refreshMicPermission();
    return false;
  });
  if (!FIXED_TAB) {
    chrome.tabs.onActivated.addListener(() => { if (!isCapturing()) refreshTargetTab(); });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === UI.targetTab?.id && info.title && !isCapturing()) refreshTargetTab(tabId);
    });
  }
}

async function init() {
  bind();
  let stored = {};
  try { stored = await chrome.storage.local.get(["serverUrl", "token", "lang", "attached"]); } catch { /* ignore */ }
  UI.t = makeT(stored.lang || "ru");
  applyI18n();
  UI.config = { serverUrl: stored.serverUrl || DEFAULT_SERVER_URL, token: stored.token || "" };
  $("server-url").value = UI.config.serverUrl;
  $("token").value = UI.config.token;
  if (!stored.token) {
    $("settings").hidden = false;
    $("settings-toggle").setAttribute("aria-expanded", "true");
  }
  renderAll();
  await Promise.all([refreshTargetTab(), refreshMicPermission(), refreshCaptureStatus()]);
  const ok = await connect();
  if (stored.attached?.id) {
    UI.session = stored.attached;
    UI.ev = initialState(stored.attached.id);
    renderAll();
    if (!UI.session.finished && UI.api) startPolling();
    else if (UI.session.finished && ok) {
      // The server keeps a finished session for a while: show its items again, if still there.
      try { UI.ev = reduceEvents(UI.ev, await UI.api.events(UI.session.id, 0)); } catch { /* expired: done card only */ }
    }
  } else if (ok) {
    await refreshSessions();
  }
  renderAll();
  document.body.dataset.ready = "1";
}

init();
