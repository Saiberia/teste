/* Recapper web UI (also runs inside the desktop app). Vanilla JS, no build step. */
(function () {
  "use strict";
  const I = window.RecapperI18n, MD = window.RecapperMarkdown;
  const t = (k) => I.t(k);
  const $ = (sel, root = document) => root.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const VIEW_PANEL = params.get("view") === "panel";

  // ---- token: from the URL once, then sessionStorage; removed from the address bar ----
  let token = "";
  try {
    if (params.get("token")) { sessionStorage.setItem("recapper_token", params.get("token")); }
    token = sessionStorage.getItem("recapper_token") || "";
  } catch (e) { token = params.get("token") || ""; }
  if (params.get("token")) {
    params.delete("token");
    history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "") + location.hash);
  }

  const S = {
    settings: {}, schema: [], meta: { templates: [], assist_actions: [] }, health: {},
    sid: null, last: 0, timer: null, items: new Map(), answers: new Map(), pending: new Set(),
    segments: [], recording: false, sessionState: null, report: null,
  };

  // ---- helpers ----------------------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v; // only used with MD.render output (escaped)
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }
  function icon(name) {
    const paths = {
      mic: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z",
      stop: "M7 7h10v10H7z", spark: "M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7z",
      send: "M3 20l18-8L3 4v6l12 2-12 2z", copy: "M8 8h11v13H8zM5 3h11v3H7v11H5z",
      check: "M9 16.2l-4.2-4.2L3.4 13.4 9 19 21 7l-1.4-1.4z", warn: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", paths[name] || "");
    svg.append(p); return svg;
  }
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers.Authorization = "Bearer " + token;
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
    const r = await fetch(path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body });
    const isJson = (r.headers.get("content-type") || "").includes("json");
    const body = isJson ? await r.json() : await r.text();
    if (!r.ok) {
      let msg = body && body.detail !== undefined ? body.detail : body;
      if (Array.isArray(msg)) msg = msg.map((d) => (d.loc ? d.loc.slice(-1)[0] + ": " : "") + d.msg).join("; ");
      const err = new Error(typeof msg === "string" && msg ? msg : r.status + " " + r.statusText);
      err.status = r.status; throw err;
    }
    return body;
  }
  function toast(msg, kind = "info") {
    const box = $("#toasts"); if (!box) return;
    const n = el("div", { class: "toast " + kind, role: "status" }, msg);
    box.append(n); setTimeout(() => n.remove(), 4500);
  }
  function fmtClock(sec) {
    if (sec === null || sec === undefined) return "";
    sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  const download = (name, data, type) => {
    const a = el("a", { href: URL.createObjectURL(new Blob([data], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  // ---- boot ---------------------------------------------------------------------------
  async function boot() {
    try { S.health = await api("/api/health"); } catch (e) { S.health = {}; }
    try {
      const s = await api("/api/settings"); S.settings = s.values; S.schema = s.schema;
      S.meta = await api("/api/meta");
    } catch (e) {
      if (e.status === 401) { document.body.replaceChildren(el("main", { class: "center" }, el("p", {}, t("need_token")))); return; }
      toast(e.message, "err");
    }
    I.lang = S.settings.ui_language || "ru";
    document.documentElement.lang = I.lang;
    applyTheme(S.settings.theme);
    if (VIEW_PANEL) { document.body.classList.add("panel"); renderPanel(); attachToCurrentSession(); return; }
    renderShell();
    route();
    window.addEventListener("hashchange", route);
    attachToCurrentSession();
  }
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  function modeLabel() {
    const m = S.health.mode || "offline";
    if (m === "offline") return t("mode_offline");
    if (m.startsWith("sim")) return t("mode_sim") + " (" + m + ")";
    if (m === "openai") return t("mode_ai") + ": " + (S.settings.openai_model || "OpenAI");
    if (m === "claude") return t("mode_ai") + ": " + (S.settings.model || "Claude").replace(/^claude-(\w)/, (_, c) => "Claude " + c.toUpperCase()).replace(/-(\d+)-(\d+)$/, " $1.$2");
    return m;
  }

  // ---- shell & routing -------------------------------------------------------------------
  const ROUTES = ["live", "meetings", "knowledge", "settings", "ai"];
  function renderShell() {
    const nav = el("nav", { class: "tabs", "aria-label": "sections" },
      ROUTES.map((r) => el("a", { href: "#/" + r, "data-route": r }, t("nav_" + r))));
    const status = el("div", { class: "status" },
      el("span", { class: "chip " + (S.health.mode === "offline" ? "warn" : "ok"), title: S.health.llm_error || "" }, modeLabel()),
      el("span", { class: "chip" }, S.health.asr && S.health.asr !== "none" ? t("asr_on") : t("asr_off")));
    document.body.replaceChildren(
      el("header", { class: "topbar" },
        el("div", { class: "brand" }, el("strong", {}, "Recapper"), el("span", { class: "muted" }, t("app_tagline"))),
        status),
      nav, el("main", { id: "view" }), el("div", { id: "toasts", "aria-live": "polite" }));
  }
  function route() {
    const [, name, arg] = (location.hash || "#/live").split("/");
    const r = ROUTES.includes(name) ? name : name === "meeting" ? "meetings" : "live";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.route === r));
    const view = $("#view");
    view.replaceChildren();
    if (name === "meeting" && arg) return renderReport(view, arg);
    ({ live: renderLive, meetings: renderMeetings, knowledge: renderKnowledge, settings: renderSettings, ai: renderAI }[r])(view);
  }

  // ---- live session -------------------------------------------------------------------------
  async function attachToCurrentSession() {
    try {
      const open = await api("/api/live");
      if (open.length && !S.sid) { await joinSession(open[0].id, open[0].title); }
      else if (VIEW_PANEL && !S.sid) { setTimeout(attachToCurrentSession, 3000); }
    } catch (e) { /* ignore */ }
  }
  async function joinSession(id, title) {
    Object.assign(S, { sid: id, last: 0, items: new Map(), answers: new Map(), pending: new Set(), segments: [], report: null, renamesApplied: 0 });
    S.title = title;
    clearInterval(S.timer); S.timer = setInterval(poll, 1200);
    await poll(); refreshLive();
  }
  async function poll() {
    if (!S.sid) return;
    let r;
    try { r = await api(`/api/live/${S.sid}/events?since=${S.last}`); }
    catch (e) {
      if (e.status === 404) { clearInterval(S.timer); S.sid = null; refreshLive(); if (VIEW_PANEL) attachToCurrentSession(); }
      return;
    }
    S.last = r.last; S.sessionState = r.state;
    for (const ev of r.events) {
      if (ev.type === "item") S.items.set(ev.data.id, ev.data);
      else if (ev.type === "answer") { S.answers.set(ev.data.item_id, ev.data); S.pending.delete(ev.data.item_id); }
      else if (ev.type === "assist") showAssist(ev.data);
      else if (ev.type === "error") toast(t("error") + ": " + ev.data.message + (ev.data.retry ? " (" + t("retry_soon") + ")" : ""), "err");
      else if (ev.type === "limit") toast(t("limit"), "warn");
      else if (ev.type === "done") {
        clearInterval(S.timer); const id = ev.data.id; S.sid = null;
        if (!VIEW_PANEL) { toast(t("done"), "ok"); location.hash = "#/meeting/" + id; } else { refreshLive(); attachToCurrentSession(); }
        return;
      }
    }
    if (r.events.length) refreshLive();
  }

  function renderLive(view) {
    const wake = (S.settings.wake_words || "").split(",").map((w) => w.trim()).filter(Boolean);
    const tplSelect = el("select", { id: "tpl", "aria-label": t("template") },
      (S.meta.templates || []).map((tp) => el("option", { value: tp.id, selected: tp.id === S.settings.default_template }, tp.name)));
    const controls = el("section", { class: "card controls" },
      el("div", { class: "row" },
        el("input", { id: "title", type: "text", placeholder: t("live_title_ph"), value: S.title || "", "aria-label": t("live_title_ph") }),
        el("label", { class: "field-inline" }, t("template"), tplSelect),
        el("button", { id: "start", class: "btn primary", onclick: startMeeting }, t("start_meeting")),
        el("label", { class: "check" }, el("input", { type: "checkbox", id: "consent" }), t("consent")),
        el("button", { id: "rec", class: "btn rec", onclick: toggleRecording }, icon("mic"), t("record")),
        el("button", { id: "finish", class: "btn ghost", onclick: finishMeeting }, t("finish"))),
      el("p", { id: "live-status", class: "muted small" }));
    const hint = el("section", { class: "card hint", id: "hint" },
      el("h2", {}, icon("spark"), t("hint_title")), el("p", {}, t("hint_body")),
      wake.length ? el("p", { class: "muted small" }, t("hint_wake") + wake.join(", ")) : null);
    const tasks = el("section", { class: "card tasks" }, el("h2", {}, t("my_tasks")), el("div", { id: "my-tasks" }),
      askBox());
    const assist = el("section", { class: "card assist" }, el("h2", {}, t("assist_title")), assistButtons(),
      el("div", { id: "assist-out", class: "muted small" }, t("assist_empty")));
    const heard = el("section", { class: "card heard" }, el("h2", {}, t("heard")), el("p", { class: "muted small" }, t("heard_hint")),
      el("div", { id: "heard" }));
    const feed = el("section", { class: "card feed" }, el("h2", {}, t("transcript")), el("div", { id: "feed", class: "feed-box" }),
      el("div", { class: "row" },
        el("input", { id: "line", type: "text", placeholder: t("line_ph"), onkeydown: (e) => { if (e.key === "Enter") sendLine(false); } }),
        el("button", { class: "btn ghost", onclick: () => sendLine(false) }, t("add_line")),
        el("button", { class: "btn ghost", onclick: () => sendLine(true) }, t("analyze_now"))));
    view.append(controls, el("div", { class: "live-grid" },
      el("div", { class: "col-main" }, hint, tasks), el("div", { class: "col-side" }, assist, heard, feed)));
    refreshLive();
  }
  function askBox() {
    const input = el("input", { type: "text", placeholder: t("ask_ph"), "aria-label": t("ask_ph"),
      onkeydown: (e) => { if (e.key === "Enter") ask(input); } });
    return el("div", { class: "row ask" }, input, el("button", { class: "btn primary", onclick: () => ask(input) }, icon("send"), t("ask")));
  }
  function assistButtons() {
    const enabled = S.settings.assist_actions || [];
    return el("div", { class: "row wrap" }, (S.meta.assist_actions || []).filter((a) => enabled.includes(a.id)).map((a) =>
      el("button", { class: "btn chip-btn", onclick: () => runAssist(a.id) }, a.title)));
  }
  function refreshLive() {
    const has = !!S.sid, st = S.sessionState;
    const setDis = (id, v) => { const n = $("#" + id); if (n) n.disabled = v; };
    setDis("start", has); setDis("finish", !has || st !== "open"); setDis("rec", !has || st !== "open");
    const status = $("#live-status");
    if (status) status.textContent = !has ? "" : st === "closing" ? t("finishing") : (S.recording ? "● " + t("stop_record") : "");
    const rec = $("#rec");
    if (rec) { rec.classList.toggle("on", S.recording); rec.lastChild.textContent = S.recording ? t("stop_record") : t("record"); }
    const items = [...S.items.values()];
    const mine = items.filter((i) => i.origin === "voice" || i.origin === "user").reverse();
    const heard = items.filter((i) => i.origin === "meeting").reverse();
    const my = $("#my-tasks");
    if (my) my.replaceChildren(...(mine.length ? mine.map((i) => itemCard(i, S.answers.get(i.id), { live: true })) : [el("p", { class: "muted" }, t("no_tasks"))]));
    const hl = $("#heard");
    if (hl) hl.replaceChildren(...(heard.length ? heard.map((i) => itemCard(i, S.answers.get(i.id), { live: true, compact: true })) : [el("p", { class: "muted small" }, t("no_heard"))]));
    const hint = $("#hint"); if (hint) hint.hidden = mine.length > 0;
    if (VIEW_PANEL) renderPanelBody();
  }
  function itemLabel(item) {
    const kind = item.kind === "question" ? t("question") : t("task");
    const who = item.origin === "voice" ? t("by_voice") : item.origin === "user" ? t("typed") : item.detector === "heuristic" ? t("possible") : "";
    return [kind + (who ? " · " + who : ""), item.speaker, fmtClock(item.start)].filter(Boolean).join(" · ");
  }
  const SEEN = new Set();
  function itemCard(item, ans, opts = {}) {
    const pending = !ans && (item.origin !== "meeting" || S.pending.has(item.id));
    const fresh = !SEEN.has(item.id + ":" + (ans ? ans.status : "wait"));  // анимируем только новое
    SEEN.add(item.id + ":" + (ans ? ans.status : "wait"));
    const card = el("article", { class: "item" + (fresh ? " fresh" : "") + (opts.compact ? " compact" : "") + (ans ? " st-" + ans.status : pending ? " pending" : "") });
    card.append(el("div", { class: "item-head" },
      el("h3", {}, item.text), el("span", { class: "meta" }, itemLabel(item))));
    if (item.quote && item.quote !== item.text && !opts.compact) card.append(el("blockquote", {}, item.quote));
    if (!ans) {
      if (pending) card.append(el("div", { class: "thinking" }, el("span", { class: "dot" }), t("answering")));
      else card.append(el("button", { class: "btn small", onclick: () => answerItem(item, opts.reportId) }, t("answer")));
      return card;
    }
    const chips = el("div", { class: "row wrap chips" }, el("span", { class: "chip st-" + ans.status }, t("status_" + ans.status)));
    if (ans.status === "draft") chips.append(el("span", { class: "chip conf-" + ans.confidence }, t("confidence") + ": " + t("conf_" + ans.confidence)));
    if (ans.warnings && ans.warnings.length) chips.append(el("span", { class: "chip warn", title: ans.warnings.join("\n") }, icon("warn"), t("ai_check_warn") + ": " + ans.warnings.length));
    card.append(chips);
    if (ans.summary) card.append(el("div", { class: "summary md", html: MD.render(ans.summary) }));
    if (ans.body && !opts.compact) card.append(el("div", { class: "md", html: MD.render(ans.body) }));
    else if (ans.body && opts.compact) card.append(el("details", {}, el("summary", {}, t("open")), el("div", { class: "md", html: MD.render(ans.body) })));
    if (ans.assumptions && ans.assumptions.length) card.append(el("details", {}, el("summary", {}, t("assumptions") + " (" + ans.assumptions.length + ")"), el("ul", {}, ans.assumptions.map((a) => el("li", {}, a)))));
    if (ans.warnings && ans.warnings.length) card.append(el("ul", { class: "warnings" }, ans.warnings.map((w) => el("li", {}, w))));
    if (ans.sources && ans.sources.length) card.append(el("div", { class: "sources" }, t("sources") + ": ",
      ans.sources.map((s, i) => [i ? ", " : "", /^https?:/.test(s.ref) ? el("a", { href: s.ref, target: "_blank", rel: "noopener noreferrer" }, s.title) : el("span", { class: "ref" }, s.title)])));
    if (ans.status !== "failed") {
      card.append(el("button", { class: "btn small ghost", onclick: async (e) => {
        const text = [item.text, ans.summary, ans.body].filter(Boolean).join("\n\n");
        try { await navigator.clipboard.writeText(text); e.target.textContent = t("copied"); } catch (err) { toast(err.message, "err"); }
      } }, icon("copy"), t("copy")));
    } else {
      card.append(el("button", { class: "btn small", onclick: () => answerItem(item, opts.reportId) }, t("answer")));
    }
    return card;
  }

  async function startMeeting() {
    const title = ($("#title") || {}).value || t("nav_live");
    try {
      const r = await api("/api/live", { json: { title, template: ($("#tpl") || {}).value || null } });
      await joinSession(r.id, title);
    } catch (e) { toast(e.message, "err"); }
  }
  async function toggleRecording() {
    const cap = window.RecapperCapture;
    if (!cap) { toast("capture.js", "err"); return; }
    if (S.recording) { await cap.stop(); S.recording = false; refreshLive(); return; }
    if (!$("#consent").checked) { toast(t("consent_needed"), "warn"); return; }
    try {
      await cap.start({ sessionId: S.sid, token,
        onStatus: (m) => toast(m, "info"), onError: (e) => toast((e && e.message) || String(e), "err"),
        onResult: (res) => { applyRenames(res.renames); (res.segments || []).forEach(addFeed); if ((res.new_items || []).length) poll(); } });
      S.recording = true;
    } catch (e) { toast(e.message, "err"); }
    refreshLive();
  }
  async function finishMeeting() {
    if (!S.sid) return;
    if (S.recording && window.RecapperCapture) { await window.RecapperCapture.stop(); S.recording = false; }
    try { await api(`/api/live/${S.sid}/finish`, { method: "POST" }); S.sessionState = "closing"; refreshLive(); }
    catch (e) { toast(e.message, "err"); }
  }
  const feedLine = (seg) => el("div", { class: "line" }, el("span", { class: "muted small" }, fmtClock(seg.start) + " "),
    el("b", {}, seg.speaker ? seg.speaker + ": " : ""), seg.text);
  // Mic and call audio arrive separately: keep the feed in time order, not arrival order.
  function addFeed(seg) {
    let i = S.segments.length;
    while (i > 0 && (S.segments[i - 1].start ?? 0) > (seg.start ?? 0)) i--;
    S.segments.splice(i, 0, seg);
    const box = $("#feed"); if (!box) return;
    if (S.segments.length === 1) box.replaceChildren();
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const line = feedLine(seg);
    const lines = box.querySelectorAll(".line");
    if (i < lines.length) box.insertBefore(line, lines[i]); else box.append(line);
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  // «Ассистент, собеседник 1 — это Артём»: relabel what is already on screen.
  function applyRenames(renames) {
    const seen = S.renamesApplied || 0;
    if (!renames || renames.length <= seen) return;
    for (const [from, to] of renames.slice(seen)) S.segments.forEach((x) => { if (x.speaker === from) x.speaker = to; });
    S.renamesApplied = renames.length;
    const box = $("#feed"); if (box && S.segments.length) box.replaceChildren(...S.segments.map(feedLine));
    poll();
  }
  async function sendLine(flush) {
    const input = $("#line"); const text = input.value.trim();
    if (!S.sid) await startMeeting();
    if (!text && !flush) return;
    try {
      const r = await api(`/api/live/${S.sid}/segments`, { json: { text, flush } });
      applyRenames(r.renames);
      if (text) { addFeed({ speaker: (/^([^:]{1,40}):/.exec(text) || [])[1] || "", text: text.replace(/^[^:]{1,40}:\s*/, "") }); input.value = ""; }
      if (r.new_items.length) poll();
    } catch (e) { toast(e.message, "err"); }
  }
  async function ask(input) {
    const q = input.value.trim(); if (q.length < 2) return;
    try {
      if (!S.sid && !VIEW_PANEL) await startMeeting();
      if (!S.sid) { toast(t("panel_open_main"), "warn"); return; }
      const item = await api(`/api/live/${S.sid}/ask`, { json: { question: q } });
      S.items.set(item.id, item); input.value = ""; refreshLive();
    } catch (e) { toast(e.message, "err"); }
  }
  async function answerItem(item, reportId) {
    S.pending.add(item.id); refreshLive();
    try {
      if (reportId) {
        const ans = await api(`/api/meetings/${reportId}/items/${item.id}/answer`, { method: "POST" });
        S.pending.delete(item.id); route(); return ans;
      }
      await api(`/api/live/${S.sid}/items/${item.id}/answer`, { method: "POST" });
      poll();
    } catch (e) { S.pending.delete(item.id); toast(e.message, "err"); refreshLive(); }
  }
  async function runAssist(action) {
    if (!S.sid) { toast(t("panel_open_main"), "warn"); return; }
    const out = $("#assist-out") || $("#p-assist-out");
    if (out) { out.textContent = t("answering"); }
    try { showAssist(await api(`/api/live/${S.sid}/assist`, { json: { action } })); }
    catch (e) { toast(e.message, "err"); }
  }
  function showAssist(data) {
    const parts = [el("h3", {}, data.title || ""), data.text ? el("p", {}, data.text) : null,
      data.bullets && data.bullets.length ? el("ul", {}, data.bullets.map((b) => el("li", {}, b))) : null].filter(Boolean);
    const inPanel = $("#p-assist-out");
    if (inPanel) { inPanel.className = "assist-result"; inPanel.replaceChildren(...parts); return; }
    const hint = $("#assist-out"); if (hint) hint.textContent = "";
    // Результат выезжает справа выдвижной панелью, не сдвигая ленту задач.
    let drawer = $("#drawer");
    if (!drawer) {
      drawer = el("aside", { id: "drawer", class: "drawer", role: "dialog", "aria-label": data.title || "" });
      document.body.append(drawer);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") drawer.classList.remove("open"); });
      document.addEventListener("pointerdown", (e) => { if (!drawer.contains(e.target)) drawer.classList.remove("open"); });
    }
    const close = el("button", { class: "btn small ghost drawer-close", "aria-label": "×", onclick: () => drawer.classList.remove("open") }, "✕");
    drawer.replaceChildren(close, el("div", { class: "assist-result" }, ...parts));
    requestAnimationFrame(() => drawer.classList.add("open"));
  }


  // ---- floating panel (desktop) ------------------------------------------------------------
  function renderPanel() {
    document.body.replaceChildren(el("div", { class: "panel-wrap" },
      el("header", { class: "panel-head" }, el("strong", {}, "Recapper"), el("span", { class: "chip " + (S.health.mode === "offline" ? "warn" : "ok") }, modeLabel())),
      el("div", { id: "panel-body" }), el("div", { id: "toasts", "aria-live": "polite" })));
    renderPanelBody();
  }
  function renderPanelBody() {
    const body = $("#panel-body"); if (!body) return;
    if (!S.sid) { body.replaceChildren(el("p", { class: "muted center" }, t("panel_open_main"))); return; }
    const items = [...S.items.values()];
    const mine = items.filter((i) => i.origin !== "meeting").reverse();
    const heard = items.filter((i) => i.origin === "meeting").reverse().slice(0, 5);
    body.replaceChildren(
      el("div", { class: "row wrap" }, (S.meta.assist_actions || []).filter((a) => (S.settings.assist_actions || []).includes(a.id))
        .map((a) => el("button", { class: "btn chip-btn small", onclick: () => runAssist(a.id) }, a.title))),
      el("div", { id: "p-assist-out", class: "muted small" }),
      el("h2", {}, t("my_tasks")),
      ...(mine.length ? mine.map((i) => itemCard(i, S.answers.get(i.id), { live: true, compact: true })) : [el("p", { class: "muted small" }, t("no_tasks"))]),
      heard.length ? el("h2", {}, t("heard")) : null,
      ...heard.map((i) => itemCard(i, S.answers.get(i.id), { live: true, compact: true })),
      askBox());
  }

  // ---- meetings list, upload, search ---------------------------------------------------------
  async function renderMeetings(view) {
    const file = el("input", { type: "file", accept: ".txt,.vtt,.srt,.md,.wav,.mp3,.m4a,.ogg,.webm,.mp4,.flac", "aria-label": t("upload_file") });
    const text = el("textarea", { placeholder: t("upload_text_ph"), rows: 5 });
    const qs = el("textarea", { placeholder: t("questions_ph"), rows: 2 });
    const title = el("input", { type: "text", placeholder: t("live_title_ph") });
    const tpl = el("select", {}, (S.meta.templates || []).map((tp) => el("option", { value: tp.id, selected: tp.id === S.settings.default_template }, tp.name)));
    const consent = el("input", { type: "checkbox" });
    const go = el("button", { class: "btn primary" }, t("process"));
    go.onclick = async () => {
      const fd = new FormData();
      fd.append("title", title.value || t("nav_live")); fd.append("questions", qs.value); fd.append("template", tpl.value);
      const f = file.files[0];
      const isAudio = f && !/\.(txt|vtt|srt|md)$/i.test(f.name);
      if (f) fd.append("file", f); else fd.append("transcript", text.value);
      if (isAudio) { if (!consent.checked) { toast(t("consent_needed"), "warn"); return; } fd.append("consent", "true"); }
      go.disabled = true;
      try {
        const r = await api(isAudio ? "/api/meetings/audio" : "/api/meetings", { body: fd });
        toast(t("processing"));
        location.hash = "#/live"; await joinSession(r.id, title.value);
      } catch (e) { toast(e.message, "err"); } finally { go.disabled = false; }
    };
    const search = el("input", { type: "search", placeholder: t("search_ph") });
    const results = el("div", { class: "search-results" });
    const doSearch = async () => {
      if (search.value.trim().length < 2) return;
      try {
        const hits = await api("/api/memory/search?q=" + encodeURIComponent(search.value.trim()));
        results.replaceChildren(...hits.map((h) => el("a", { class: "hit", href: "#/meeting/" + h.meeting_id },
          el("b", {}, h.title), el("span", { class: "muted small" }, " · " + h.date), el("p", {}, h.text.slice(0, 280)))));
        if (!hits.length) results.replaceChildren(el("p", { class: "muted" }, t("no_heard")));
      } catch (e) { toast(e.message, "err"); }
    };
    const askAll = async () => {
      if (search.value.trim().length < 2) return;
      results.replaceChildren(el("div", { class: "thinking" }, el("span", { class: "dot" }), t("answering")));
      try {
        const r = await api("/api/ask", { json: { question: search.value.trim() } });
        results.replaceChildren(el("div", { class: "md", html: MD.render(r.answer) }),
          el("div", { class: "row wrap" }, (r.suggestions || []).map((s) => el("button", { class: "btn chip-btn small", onclick: () => { search.value = s; askAll(); } }, s))));
      } catch (e) { toast(e.message, "err"); }
    };
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    const list = el("div", { class: "meeting-list" }, el("p", { class: "muted" }, "…"));
    view.append(
      el("section", { class: "card" }, el("h2", {}, t("upload")),
        el("div", { class: "grid2" }, el("div", {}, title, tpl, el("label", { class: "field" }, t("upload_file"), file),
          el("label", { class: "check" }, consent, t("consent"))), el("div", {}, text, qs)),
        el("div", { class: "row" }, go)),
      el("section", { class: "card" }, el("h2", {}, t("meetings_title")),
        el("div", { class: "row" }, search, el("button", { class: "btn ghost", onclick: doSearch }, t("search")),
          el("button", { class: "btn", onclick: askAll }, t("ask_all"))), results, list));
    try {
      const rows = await api("/api/meetings");
      list.replaceChildren(...(rows.length ? rows.map((r) => el("div", { class: "meeting-row" },
        el("a", { href: "#/meeting/" + r.id }, r.title), el("span", { class: "muted small" }, r.created_at.slice(0, 16).replace("T", " ")),
        el("button", { class: "btn small ghost", onclick: async () => {
          if (!confirm(t("delete_confirm"))) return;
          try { await api("/api/meetings/" + r.id, { method: "DELETE" }); route(); } catch (e) { toast(e.message, "err"); }
        } }, t("delete")))) : [el("p", { class: "muted" }, t("no_meetings"))]));
    } catch (e) { list.replaceChildren(el("p", { class: "err" }, e.message)); }
  }

  // ---- report ------------------------------------------------------------------------------
  async function renderReport(view, id) {
    let report;
    try { report = await api("/api/meetings/" + id); } catch (e) { view.append(el("p", { class: "err" }, e.message)); return; }
    const answers = new Map(report.answers.map((a) => [a.item_id, a]));
    const mine = report.items.filter((i) => i.origin !== "meeting");
    const heard = report.items.filter((i) => i.origin === "meeting");
    const r = report.recap;
    const tplName = ((S.meta.templates || []).find((x) => x.id === report.template) || {}).name || "";
    const exportBtn = (kind) => el("button", { class: "btn small ghost", onclick: async () => {
      try {
        if (kind === "json") download(`recapper-${id}.json`, JSON.stringify(report, null, 2), "application/json");
        else if (kind === "html") {
          const page = await (await fetch(`/api/meetings/${id}/html`, { headers: { Authorization: "Bearer " + token } })).text();
          download(`recapper-${id}.html`, page, "text/html");
          const w = window.open(URL.createObjectURL(new Blob([page], { type: "text/html" })), "_blank");
          if (w) setTimeout(() => { try { w.print(); } catch (e) { /* user can print manually */ } }, 800);
        }
        else if (kind === "md") download(`recapper-${id}.md`, await api(`/api/meetings/${id}/markdown`), "text/markdown");
        else {
          const resp = await fetch(`/api/meetings/${id}/docx`, { headers: { Authorization: "Bearer " + token } });
          if (!resp.ok) throw new Error(resp.statusText);
          download(`recapper-${id}.docx`, await resp.blob(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        }
      } catch (e) { toast(e.message, "err"); }
    } }, t("export_" + kind));
    const speakers = [...new Set(report.segments.map((s) => s.speaker).filter(Boolean))];
    const speakerEditor = el("details", {}, el("summary", {}, t("speakers") + " (" + speakers.length + ")"),
      ...speakers.map((sp) => {
        const input = el("input", { type: "text", value: sp });
        return el("div", { class: "row" }, input, el("button", { class: "btn small", onclick: async () => {
          if (!input.value.trim() || input.value === sp) return;
          try { await api(`/api/meetings/${id}/speakers`, { json: { old: sp, new: input.value.trim() } }); route(); } catch (e) { toast(e.message, "err"); }
        } }, t("rename")));
      }));
    const chatLog = el("div", { class: "chat-log" });
    const chatInput = el("input", { type: "text", placeholder: t("chat_ph") });
    const sendChat = async (q) => {
      q = (q || chatInput.value).trim(); if (q.length < 2) return;
      chatInput.value = "";
      chatLog.append(el("div", { class: "bubble me" }, q));
      const wait = el("div", { class: "bubble thinking" }, el("span", { class: "dot" }), t("answering")); chatLog.append(wait);
      try {
        const res = await api(`/api/meetings/${id}/chat`, { json: { question: q } });
        wait.replaceWith(el("div", { class: "bubble ai" }, el("div", { class: "md", html: MD.render(res.answer) }),
          el("div", { class: "row wrap" }, (res.suggestions || []).map((s) => el("button", { class: "btn chip-btn small", onclick: () => sendChat(s) }, s)))));
      } catch (e) { wait.replaceWith(el("div", { class: "bubble err" }, e.message)); }
    };
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
    view.append(
      el("div", { class: "row" }, el("a", { href: "#/meetings", class: "btn ghost small" }, "← " + t("back")),
        el("h1", {}, report.title), el("span", { class: "muted small" }, report.created_at.slice(0, 16).replace("T", " ") + (tplName ? " · " + tplName : "")),
        el("span", { class: "spacer" }), exportBtn("html"), exportBtn("md"), exportBtn("docx"), exportBtn("json")),
      el("div", { class: "live-grid" },
        el("div", { class: "col-main" },
          el("section", { class: "card" }, el("h2", {}, t("recap")), el("p", {}, r.summary || "—"),
            r.decisions.length ? [el("h3", {}, t("decisions")), el("ul", {}, r.decisions.map((d) => el("li", {}, d)))] : null,
            r.action_items.length ? [el("h3", {}, t("action_items")), el("ul", {}, r.action_items.map((a) => el("li", {}, a.text, a.owner || a.due ? el("span", { class: "muted" }, " — " + [a.owner, a.due].filter(Boolean).join(", ")) : null)))] : null,
            (r.sections || []).filter((s) => s.bullets.length).map((s) => [el("h3", {}, s.title), el("ul", {}, s.bullets.map((b) => el("li", {}, b)))])),
          el("section", { class: "card tasks" }, el("h2", {}, t("my_tasks") + " (" + mine.length + ")"),
            ...(mine.length ? mine.map((i) => itemCard(i, answers.get(i.id), { reportId: id })) : [el("p", { class: "muted" }, t("no_tasks"))]))),
        el("div", { class: "col-side" },
          el("section", { class: "card" }, el("h2", {}, t("chat_title")), chatLog,
            el("div", { class: "row" }, chatInput, el("button", { class: "btn primary", onclick: () => sendChat() }, icon("send"), t("ask")))),
          el("section", { class: "card heard" }, el("h2", {}, t("heard") + " (" + heard.length + ")"),
            ...(heard.length ? heard.map((i) => itemCard(i, answers.get(i.id), { reportId: id, compact: true })) : [el("p", { class: "muted small" }, t("no_heard"))])),
          el("section", { class: "card" }, speakerEditor,
            el("details", {}, el("summary", {}, t("transcript") + " (" + report.segments.length + ")"),
              el("div", { class: "feed-box" }, report.segments.map((s) => el("div", { class: "line" },
                el("span", { class: "muted small" }, fmtClock(s.start) + " "), el("b", {}, s.speaker ? s.speaker + ": " : ""), s.text))))))));
  }

  // ---- knowledge -------------------------------------------------------------------------
  async function renderKnowledge(view) {
    const file = el("input", { type: "file", accept: ".md,.txt,.csv,.markdown" });
    const list = el("div");
    const load = async () => {
      try {
        const rows = await api("/api/knowledge");
        list.replaceChildren(...(rows.length ? rows.map((r) => el("div", { class: "meeting-row" }, el("span", {}, r.name),
          el("span", { class: "muted small" }, Math.ceil(r.size / 1024) + " KB"),
          el("button", { class: "btn small ghost", onclick: async () => { await api("/api/knowledge/" + encodeURIComponent(r.name), { method: "DELETE" }); load(); } }, t("delete"))))
          : [el("p", { class: "muted" }, t("no_kb"))]));
      } catch (e) { toast(e.message, "err"); }
    };
    view.append(el("section", { class: "card" }, el("h2", {}, t("knowledge_title")), el("p", { class: "muted" }, t("knowledge_hint")),
      el("div", { class: "row" }, file, el("button", { class: "btn primary", onclick: async () => {
        if (!file.files[0]) return; const fd = new FormData(); fd.append("file", file.files[0]);
        try { await api("/api/knowledge", { body: fd }); file.value = ""; load(); toast(t("saved"), "ok"); } catch (e) { toast(e.message, "err"); }
      } }, t("upload_kb"))), list));
    load();
  }

  // ---- settings (generated from the server schema) ----------------------------------------------
  function renderSettings(view) {
    const L = I.lang;
    const form = el("form", { class: "settings", onsubmit: (e) => e.preventDefault() });
    const inputs = {};
    const groups = {};
    const inDesktop = !!window.recapperDesktop;
    for (const f of S.schema) {
      if (f.scope === "desktop" && f.group === "desktop" && !inDesktop) continue; // panel options exist only in the app
      if (!groups[f.group]) { groups[f.group] = el("fieldset", {}, el("legend", {}, f.group_label[L] || f.group_label.ru)); form.append(groups[f.group]); }
      const val = S.settings[f.key];
      let input;
      if (f.type === "bool") input = el("input", { type: "checkbox", checked: !!val });
      else if (f.type === "enum") input = el("select", {}, f.options.map((o) => el("option", { value: o.value, selected: o.value === val }, o.label[L] || o.label.ru)));
      else if (f.type === "multi") input = el("div", { class: "multi" }, f.options.map((o) => el("label", { class: "check" },
        el("input", { type: "checkbox", value: o.value, checked: (val || []).includes(o.value) }), o.label[L] || o.label.ru)));
      else if (f.type === "secret") input = el("input", { type: "password", autocomplete: "off", placeholder: (val && val.set ? t("secret_set") : t("secret_empty")) + " — " + t("secret_ph") });
      else if (f.type === "int" || f.type === "float") input = el("input", { type: "number", step: f.type === "int" ? "1" : "0.001", min: f.min ?? "", max: f.max ?? "", value: val ?? "" });
      else input = el("input", { type: "text", value: val ?? "" });
      const row = el("label", { class: "setting", "data-key": f.key },
        el("span", { class: "label" }, f.label[L] || f.label.ru, f.restart ? el("em", { class: "muted small" }, " · " + t("restart_note")) : null),
        input, f.help[L] ? el("span", { class: "muted small" }, f.help[L]) : null);
      inputs[f.key] = { f, input, row };
      groups[f.group].append(row);
    }
    // Show only the fields that apply to the current choice (e.g. the key of the selected AI provider).
    const syncVisibility = () => {
      for (const { f, row } of Object.values(inputs)) {
        if (!f.show_if) continue;
        const ctl = inputs[f.show_if.key];
        row.hidden = !!ctl && !f.show_if.values.includes(ctl.input.value);
      }
      if (testRow) testRow.hidden = inputs.openai_base_url ? inputs.openai_base_url.row.hidden : true;
    };
    // OpenAI-compatible server: test the unsaved values and offer the server's models.
    let testRow = null;
    if (inputs.openai_model) {
      const list = el("datalist", { id: "openai-models" });
      inputs.openai_model.input.setAttribute("list", "openai-models");
      inputs.openai_model.input.setAttribute("autocomplete", "off");
      const status = el("span", { class: "muted small", role: "status" });
      const btn = el("button", { class: "btn small", type: "button" }, t("ai_test"));
      btn.onclick = async () => {
        btn.disabled = true; status.className = "muted small"; status.textContent = t("ai_testing");
        try {
          const r = await api("/api/ai/test", { json: { base_url: inputs.openai_base_url.input.value.trim(),
            api_key: inputs.openai_api_key.input.value.trim(), model: inputs.openai_model.input.value.trim() } });
          list.replaceChildren(...r.models.map((m) => el("option", { value: m })));
          if (r.base_url && inputs.openai_base_url.input.value.trim() !== r.base_url) inputs.openai_base_url.input.value = r.base_url;
          const found = r.models.length ? t("ai_models_found") + ": " + r.models.length + ". " : (r.models_error ? r.models_error + ". " : "");
          if (r.ok) { status.className = "ok small"; status.textContent = found + t("ai_test_ok") + ": «" + r.reply + "»"; }
          else { status.className = "err small"; status.textContent = found + r.error; }
          if (!r.ok && r.models.length) { inputs.openai_model.input.value = ""; inputs.openai_model.input.placeholder = t("ai_pick_model"); inputs.openai_model.input.focus(); }
        } catch (e) { status.className = "err small"; status.textContent = e.message; }
        finally { btn.disabled = false; }
      };
      testRow = el("div", { class: "setting" }, el("div", { class: "row wrap" }, btn, status), list);
      inputs.openai_model.row.after(testRow);
    }
    for (const { input } of Object.values(inputs)) if (input.tagName === "SELECT") input.addEventListener("change", syncVisibility);
    syncVisibility();
    const save = el("button", { class: "btn primary", type: "button" }, t("save"));
    save.onclick = async () => {
      const values = {};
      for (const [key, { f, input }] of Object.entries(inputs)) {
        let v;
        if (f.type === "bool") v = input.checked;
        else if (f.type === "multi") v = [...input.querySelectorAll("input:checked")].map((x) => x.value);
        else if (f.type === "secret") { if (!input.value) continue; v = input.value; }
        else if (f.type === "int") v = parseInt(input.value, 10);
        else if (f.type === "float") v = parseFloat(input.value);
        else v = input.value;
        const old = S.settings[key];
        if (JSON.stringify(v) !== JSON.stringify(old)) values[key] = v;
      }
      if (!Object.keys(values).length) { toast(t("saved"), "ok"); return; }
      save.disabled = true;
      try {
        const r = await api("/api/settings", { method: "PUT", json: { values } });
        S.settings = r.values; S.health.mode = r.mode; S.health.llm_error = r.llm_error;
        if (window.recapperDesktop && window.recapperDesktop.applySettings) {
          const res = await window.recapperDesktop.applySettings(r.values);
          if (res && res.ok === false) toast(res.error, "err");
        }
        I.lang = S.settings.ui_language; applyTheme(S.settings.theme);
        toast(t("saved") + (r.llm_error ? " · " + r.llm_error : ""), r.llm_error ? "warn" : "ok");
        renderShell(); route();
      } catch (e) { toast(e.message, "err"); } finally { save.disabled = false; }
    };
    view.append(el("section", { class: "card" }, el("h2", {}, t("settings_title")), form, el("div", { class: "row sticky" }, save)));
  }

  // ---- AI check (interception log) --------------------------------------------------------------
  async function renderAI(view) {
    const box = el("div");
    view.append(el("section", { class: "card" }, el("h2", {}, t("ai_title")), el("p", { class: "muted" }, t("ai_hint")), box));
    try {
      const r = await api("/api/traces?limit=100");
      const rec = r.records.slice().reverse();
      box.append(el("div", { class: "row" }, el("span", { class: "chip" }, t("ai_provider") + ": " + r.provider),
        el("span", { class: "chip" }, t("ai_calls") + ": " + rec.length),
        el("span", { class: "chip " + (r.issues ? "warn" : "ok") }, t("ai_issues") + ": " + (r.issues || 0))));
      if (!rec.length) { box.append(el("p", { class: "muted" }, t("ai_none"))); return; }
      box.append(...rec.map((x) => el("details", { class: "trace" + (x.issues.length ? " bad" : "") },
        el("summary", {}, el("b", {}, x.task), " · " + x.ts.slice(11, 19) + " · " + x.latency_ms + " " + t("latency"),
          x.issues.length ? el("span", { class: "chip warn" }, t("issues") + ": " + x.issues.length) : el("span", { class: "chip ok" }, "OK")),
        x.issues.length ? el("ul", { class: "warnings" }, x.issues.map((i) => el("li", {}, i))) : null,
        el("h4", {}, t("prompt")), el("pre", {}, x.prompt),
        el("h4", {}, t("output")), el("pre", {}, x.error ? "ERROR: " + x.error : JSON.stringify(x.output, null, 2)))));
    } catch (e) { box.append(el("p", { class: "err" }, e.message)); }
  }

  window.RecapperApp = { boot, state: S, api };
  document.addEventListener("DOMContentLoaded", boot);
})();
