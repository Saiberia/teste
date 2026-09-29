/*
 * Offscreen document (chrome.offscreen, reason USER_MEDIA): captures the
 * meeting tab's audio (other participants) and the microphone, cuts both into
 * 16 kHz mono WAV chunks and uploads them to the Recapper server.
 *
 * Messages in  (target "offscreen"): start | stop | status  → {ok, status|error}
 * Messages out (target "panel", type "capture-event"): state changes, uploads,
 *   warnings and errors, so the side panel and the service worker (badge) can follow.
 */

import { audioUrl } from "./lib/api.js";
import { Chunker, MIN_FLUSH_SECONDS, prepareChunk } from "./lib/chunker.js";
import { rms } from "./lib/dsp.js";
import { Uploader } from "./lib/uploader.js";

const DRAIN_TIMEOUT_MS = 20000;
const LEVEL_INTERVAL_MS = 1000;

let session = null; // the running capture
let stopping = null; // promise of an in-progress stop
let lastSnapshot = { state: "idle" };

function emit(event) {
  chrome.runtime.sendMessage({ target: "panel", type: "capture-event", event }).catch(() => {
    /* nobody is listening (side panel closed) */
  });
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
}

// ------------------------------------------------------------------ pipeline ---
/** One source: MediaStream → AudioContext → worklet → Chunker → WAV → Uploader. */
class Pipeline {
  constructor(kind, stream, cfg) {
    this.kind = kind;
    this.stream = stream;
    this.cfg = cfg; // {chunkSeconds, silenceThreshold, t0, uploader, playback, onEnded}
    this.startOffset = null;
    this.stopped = false;
    this.flushing = false;
    this.peak = 0;
    this.stats = { chunks: 0, skipped: 0 };
  }

  async start() {
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(this.stream);
    this.src = src;
    // Capturing a tab mutes it for the user: play it back so the meeting stays audible.
    if (this.cfg.playback) src.connect(ctx.destination);
    this.chunker = new Chunker(ctx.sampleRate, this.cfg.chunkSeconds, (c) => this.onChunk(c));
    this.sink = ctx.createGain();
    this.sink.gain.value = 0; // keeps the capture node pulled without playing it
    this.sink.connect(ctx.destination);
    let node = null;
    try {
      await ctx.audioWorklet.addModule(chrome.runtime.getURL("capture-worklet.js"));
      node = new AudioWorkletNode(ctx, "recapper-capture", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
      });
      node.port.onmessage = (e) => {
        if (e.data === "flushed") { this.onFlushed?.(); return; }
        this.onBlock(e.data);
      };
      this.mode = "worklet";
    } catch {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        this.onBlock(new Float32Array(e.inputBuffer.getChannelData(0)));
        e.outputBuffer.getChannelData(0).fill(0);
      };
      this.mode = "script-processor";
    }
    this.node = node;
    src.connect(node);
    node.connect(this.sink);
    if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* reported via state */ } }
    this.stream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => {
      if (!this.stopped) this.cfg.onEnded(this.kind);
    }));
    return { sampleRate: ctx.sampleRate, mode: this.mode, contextState: ctx.state };
  }

  onBlock(block) {
    if (this.stopped && !this.flushing) return;
    if (this.startOffset === null) {
      this.startOffset = Math.max(0, (performance.now() - this.cfg.t0) / 1000 - block.length / this.ctx.sampleRate);
    }
    const level = rms(block);
    if (level > this.peak) this.peak = level;
    this.chunker.push(block);
  }

  onChunk(chunk) {
    const job = prepareChunk(chunk, { startOffset: this.startOffset || 0, silenceThreshold: this.cfg.silenceThreshold });
    if (job.skip) { this.stats.skipped++; return; }
    this.stats.chunks++;
    this.cfg.uploader.enqueue(job);
  }

  takePeak() {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  /** Stops capturing; with flush=true the partial chunk is uploaded first. */
  async stop(flush) {
    if (this.stopped) return;
    this.stopped = true;
    if (flush && this.node && this.mode === "worklet") {
      this.flushing = true;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 300);
        this.onFlushed = () => { clearTimeout(t); resolve(); };
        try { this.node.port.postMessage("flush"); } catch { clearTimeout(t); resolve(); }
      });
      this.flushing = false;
    }
    if (flush && this.chunker) this.chunker.flush(MIN_FLUSH_SECONDS);
    try { this.src?.disconnect(); } catch { /* ignore */ }
    try { this.node?.disconnect(); } catch { /* ignore */ }
    if (this.node?.port) this.node.port.onmessage = null;
    if (this.node && this.mode === "script-processor") this.node.onaudioprocess = null;
    stopStream(this.stream);
    if (this.ctx && this.ctx.state !== "closed") { try { await this.ctx.close(); } catch { /* ignore */ } }
  }
}

// ------------------------------------------------------------------ session ---
function mediaErrorCode(kind, err) {
  if (kind === "mic") return err?.name === "NotAllowedError" || err?.name === "SecurityError" ? "mic_permission" : "mic_unavailable";
  return "system_unavailable";
}

function acquire(kind, opts) {
  if (kind === "system") {
    if (!opts.streamId) return Promise.reject(Object.assign(new Error("no tab stream id"), { name: "NoStreamId" }));
    return navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: opts.streamId } },
      video: false,
    });
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

function snapshotOf(s) {
  const sources = {};
  for (const [kind, info] of Object.entries(s.sources)) {
    const up = s.uploaders[kind];
    const p = s.pipelines[kind];
    sources[kind] = {
      ...info,
      sent: up ? up.stats.sent : 0,
      failed: up ? up.stats.failed : 0,
      retried: up ? up.stats.retried : 0,
      dropped: up ? up.stats.dropped : 0,
      chunks: p ? p.stats.chunks : 0,
      skipped: p ? p.stats.skipped : 0,
    };
  }
  return {
    state: s.state,
    sessionId: s.id,
    startedAt: s.startedAt,
    reason: s.reason || null,
    fatal: s.fatal || null,
    warnings: s.warnings.slice(),
    chunkSeconds: s.opts.chunkSeconds,
    silenceThreshold: s.opts.silenceThreshold,
    sources,
  };
}

function snapshot() {
  return session ? snapshotOf(session) : lastSnapshot;
}

function emitState(s) {
  const status = snapshotOf(s);
  if (!session || session === s) lastSnapshot = status;
  emit({ kind: "state", status });
}

async function start(opts) {
  if (stopping) await stopping;
  if (session) return { ok: false, error: { code: "already_running" }, status: snapshot() };
  if (!opts?.sessionId || !opts?.serverUrl) return { ok: false, error: { code: "bad_options" } };
  const s = {
    id: opts.sessionId,
    opts,
    state: "starting",
    sources: {},
    warnings: [],
    pipelines: {},
    uploaders: {},
    streams: [],
    t0: performance.now(),
    startedAt: Date.now(),
  };
  session = s;
  emitState(s);
  s.starting = startSources(s, opts);
  return s.starting;
}

async function startSources(s, opts) {
  const kinds = (opts.sources || []).filter((k) => k === "mic" || k === "system");
  const results = {};
  await Promise.all(kinds.map(async (kind) => {
    try { results[kind] = { stream: await acquire(kind, opts) }; } catch (error) { results[kind] = { error }; }
  }));

  const url = audioUrl(opts.serverUrl, opts.sessionId);
  for (const kind of kinds) {
    const r = results[kind];
    if (r.error) {
      const code = mediaErrorCode(kind, r.error);
      s.sources[kind] = { state: "failed", code, message: `${r.error.name || "Error"}: ${r.error.message || ""}` };
      s.warnings.push({ code, source: kind, message: s.sources[kind].message });
      continue;
    }
    s.streams.push(r.stream);
    const uploader = new Uploader({
      url, token: opts.token, source: kind, fetch: (...a) => fetch(...a),
      onResult: (body, meta) => {
        emit({ kind: "uploaded", source: kind, offset: meta.offset, duration: meta.duration,
          added: body?.added ?? 0, newItems: Array.isArray(body?.new_items) ? body.new_items.length : 0 });
      },
      onError: (err) => onUploadError(s, err),
      onWarning: (code) => emit({ kind: "warning", code, source: kind }),
    });
    s.uploaders[kind] = uploader;
    const pipeline = new Pipeline(kind, r.stream, {
      chunkSeconds: opts.chunkSeconds, silenceThreshold: opts.silenceThreshold, t0: s.t0, uploader,
      playback: kind === "system", onEnded: (k) => onTrackEnded(s, k),
    });
    s.pipelines[kind] = pipeline;
    try {
      const info = await pipeline.start();
      s.sources[kind] = { state: "on", playback: kind === "system", mode: info.mode, sampleRate: info.sampleRate,
        contextState: info.contextState };
    } catch (e) {
      s.sources[kind] = { state: "failed", code: `${kind}_unavailable`, message: String(e?.message || e) };
      s.warnings.push({ code: `${kind}_unavailable`, source: kind, message: s.sources[kind].message });
      await pipeline.stop(false).catch(() => {});
      delete s.pipelines[kind];
      uploader.close();
      delete s.uploaders[kind];
    }
  }

  if (!Object.values(s.sources).some((x) => x.state === "on")) {
    s.streams.forEach(stopStream);
    s.state = "stopped";
    s.reason = "no_sources";
    lastSnapshot = snapshotOf(s);
    session = null;
    emit({ kind: "state", status: lastSnapshot });
    return { ok: false, error: { code: "no_sources", warnings: s.warnings }, status: lastSnapshot };
  }
  if (s !== session) return { ok: false, error: { code: "cancelled" }, status: snapshot() };
  s.state = "running";
  s.levelTimer = setInterval(() => {
    const levels = {};
    for (const [kind, p] of Object.entries(s.pipelines)) levels[kind] = Number(p.takePeak().toFixed(4));
    emit({ kind: "levels", sessionId: s.id, levels });
  }, LEVEL_INTERVAL_MS);
  emitState(s);
  return { ok: true, status: snapshotOf(s) };
}

function onUploadError(s, err) {
  emit({ kind: "upload-error", sessionId: s.id, ...err });
  if (err.fatal && !s.fatal) {
    s.fatal = err.code;
    // Nothing more can be delivered to this session: stop without flushing.
    Promise.resolve().then(() => { if (session === s) stop({ flush: false, reason: err.code }); });
  }
}

function onTrackEnded(s, kind) {
  if (session !== s) return;
  s.sources[kind] = { ...s.sources[kind], state: "ended" };
  emit({ kind: "warning", code: `track_ended_${kind}`, source: kind });
  s.pipelines[kind]?.stop(true);
  if (!Object.values(s.sources).some((x) => x.state === "on")) stop({ flush: true, reason: "tracks_ended" });
  else emitState(s);
}

function stop({ flush = true, reason = "user" } = {}) {
  if (stopping) return stopping.then(() => ({ ok: true, status: lastSnapshot }));
  const s = session;
  if (!s) return Promise.resolve({ ok: true, status: lastSnapshot });
  stopping = (async () => {
    if (s.starting) await s.starting.catch(() => {});
    if (session !== s) return; // start failed and already cleaned up
    s.state = "stopping";
    emitState(s);
    clearInterval(s.levelTimer);
    const doFlush = flush && !s.fatal;
    await Promise.all(Object.values(s.pipelines).map((p) => p.stop(doFlush).catch(() => {})));
    s.streams.forEach(stopStream);
    const ups = Object.values(s.uploaders);
    if (doFlush) await Promise.all(ups.map((u) => u.drain(DRAIN_TIMEOUT_MS)));
    ups.forEach((u) => u.close());
    s.state = "stopped";
    s.reason = reason;
    session = null;
    lastSnapshot = snapshotOf(s);
    emit({ kind: "state", status: lastSnapshot });
  })().finally(() => { stopping = null; });
  return stopping.then(() => ({ ok: true, status: lastSnapshot }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  const run = {
    start: () => start(msg.options),
    stop: () => stop({ flush: msg.flush !== false, reason: msg.reason || "user" }),
    status: async () => ({ ok: true, status: snapshot() }),
  }[msg.type];
  if (!run) return false;
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: { code: "offscreen_error", message: String(e?.message || e) } }));
  return true;
});
