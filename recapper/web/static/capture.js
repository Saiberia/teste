/*
 * Recapper audio capture (dependency-free, works in the desktop app and in a
 * plain browser).
 *
 *   await RecapperCapture.start({ sessionId, token, onStatus, onError, onResult });
 *   ...
 *   await RecapperCapture.stop();   // uploads the last partial chunk, then releases devices
 *
 * start() options: sessionId (required), token, baseUrl (default: same origin),
 *   chunkSeconds, sources (['mic','system']), silenceThreshold (RMS of the loudest
 *   100 ms frame below which a chunk is skipped) — each of these three, when
 *   omitted, comes from GET /api/settings (capture_chunk_seconds, capture_sources,
 *   capture_silence_threshold), else defaults 12 / both / 0.004;
 *   systemTimeoutMs (default 12000: give up on system audio if getDisplayMedia hangs),
 *   silenceWarnMs (default 20000: onStatus warning '<source>_silent' once if a source
 *   delivered nothing but digital silence by then; 0 disables),
 *   fetch (injectable for tests). Resolves {sources, warnings, sampleRates, modes, config}.
 *
 * Microphone: getUserMedia (echo cancellation + noise suppression).
 * System audio (other call participants):
 *   - desktop app: window.recapperDesktop.enableLoopbackAudio() + getDisplayMedia
 *     (electron-audio-loopback; no picker), video tracks dropped;
 *   - plain browser: getDisplayMedia, the user picks a tab and ticks "share tab audio".
 *   If system audio is unavailable, capture continues with the microphone only
 *   and onStatus receives a warning.
 * Each source has its own AudioContext → AudioWorklet (ScriptProcessor fallback)
 * → 16 kHz mono → WAV (PCM16) chunks of ~chunkSeconds, cut at the quietest
 * moment near the boundary so words are not split. Silent chunks are skipped.
 * Chunks are POSTed to /api/live/{sid}/audio (multipart: file, source, offset)
 * strictly in order per source; a network error is retried once.
 *
 * Callbacks:
 *   onStatus(message, detail)   message: human-readable Russian string (ready for a toast);
 *                  detail: {state, level, code, message, sources}
 *                  state: starting|running|warning|stopping|stopped, level: info|warning|error
 *   onError(err)   err: Error with {code, status, source, fatal}. Fatal errors (401, 404, 409
 *                  session closed, 503 ASR not configured) stop the capture automatically.
 *   onResult(body, {source, offset, duration, seq})   JSON body of each successful upload.
 *   onLevel({mic, system})   ~12 times/s while running (also while paused): 0..1 meter per
 *                  source on a dB scale, clamp((20·log10(rms over ~100 ms) + 60) / 60, 0, 1);
 *                  null for a source that is not being captured.
 *
 * Other API: running (devices open, also while paused), paused, sources, levels,
 *   pause() / resume() — stop/continue sending audio without releasing devices
 *   (pause uploads what was recorded so far; offsets keep following wall-clock
 *   time, so a later chunk's offset includes the pause), elapsed() — seconds
 *   recorded since start(), excluding pauses, stats().
 */
(function (root) {
  'use strict';

  var TARGET_RATE = 16000;
  var DEFAULTS = { chunkSeconds: 12, sources: ['mic', 'system'], silenceThreshold: 0.004 };
  var KNOWN_SOURCES = ['mic', 'system'];
  var SILENCE_FRAME_SECONDS = 0.1;   // silence = no 100 ms frame louder than the threshold
  var CUT_FRAME_SECONDS = 0.02;      // resolution when looking for a pause to cut at
  var MIN_FLUSH_SECONDS = 0.4;       // shorter tails are dropped on stop()
  var MAX_QUEUE = 40;                // per source (~8 min of audio at 12 s chunks)
  var DISPLAY_MEDIA_TIMEOUT_MS = 12000;
  var SILENCE_WARN_MS = 20000;       // warn once if a source delivers only digital silence
  var DIGITAL_SILENCE = 1e-4;        // |sample| below this counts as "nothing arrives"
  var SETTINGS_TIMEOUT_MS = 3000;
  var DRAIN_TIMEOUT_MS = 20000;
  var RETRY_DELAY_MS = 1000;
  var WORKLET_BLOCK = 1024;          // ~64 ms at 16 kHz: smooth level meters
  var LEVEL_INTERVAL_MS = 80;        // onLevel ~12.5 times per second
  var LEVEL_WINDOW_S = 0.1;          // level = RMS over roughly the last 100 ms
  var LEVEL_FLOOR_DB = -60;          // -60 dBFS -> 0, 0 dBFS -> 1
  var LEVEL_STALE_MS = 500;          // no audio frames for this long -> level 0

  // ---------------------------------------------------------------- DSP ---
  function rms(samples) {
    var n = samples ? samples.length : 0;
    if (!n) return 0;
    var sum = 0;
    for (var i = 0; i < n; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / n);
  }

  /** Loudest RMS over consecutive frames of `frameSeconds`. */
  function peakFrameRms(samples, sampleRate, frameSeconds) {
    var frame = Math.max(1, Math.round(sampleRate * (frameSeconds || SILENCE_FRAME_SECONDS)));
    var peak = 0;
    for (var start = 0; start < samples.length; start += frame) {
      var end = Math.min(samples.length, start + frame);
      var sum = 0;
      for (var i = start; i < end; i++) sum += samples[i] * samples[i];
      var r = Math.sqrt(sum / (end - start));
      if (r > peak) peak = r;
    }
    return peak;
  }

  function isSilent(samples, sampleRate, threshold) {
    if (!samples.length) return true;
    return peakFrameRms(samples, sampleRate, SILENCE_FRAME_SECONDS) < threshold;
  }

  /**
   * Perceptual meter value: 0..1 on a dB scale,
   * level = clamp((20·log10(rms) + 60) / 60, 0, 1) — -60 dBFS (silence) → 0,
   * normal speech (-30…-15 dBFS) → 0.5…0.75, full scale → 1.
   */
  function levelFromRms(r) {
    if (!(r > 0)) return 0;
    var db = 20 * Math.log10(r);
    var v = (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  var kernelCache = {};
  // Windowed-sinc (Hann) low-pass kernels, quantized to 64 fractional phases.
  function sincKernels(ratio) {
    var key = ratio.toFixed(6);
    if (kernelCache[key]) return kernelCache[key];
    var PHASES = 64;
    var half = Math.ceil(8 * ratio);
    var cutoff = 0.9 * 0.5 / ratio; // cycles per input sample (~7.2 kHz for 16 kHz output)
    var width = 2 * half;
    var table = new Float32Array(PHASES * width);
    for (var p = 0; p < PHASES; p++) {
      var frac = p / PHASES;
      var sum = 0;
      for (var j = 0; j < width; j++) {
        var t = (j - half + 1) - frac; // offset of tap from the exact output position
        var x = 2 * cutoff * t;
        var sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        var w = Math.abs(t) >= half ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t / half);
        table[p * width + j] = sinc * w;
        sum += sinc * w;
      }
      for (j = 0; j < width; j++) table[p * width + j] /= sum; // unity DC gain
    }
    kernelCache[key] = { table: table, half: half, width: width, phases: PHASES };
    return kernelCache[key];
  }

  /**
   * Resamples mono float32 audio. Decimation uses an anti-aliasing windowed-sinc
   * low-pass; upsampling uses linear interpolation. Returns a new Float32Array.
   */
  function downsample(input, fromRate, toRate) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
    var n = input.length;
    if (fromRate === toRate) return new Float32Array(input);
    var ratio = fromRate / toRate;
    var outLen = Math.floor(n / ratio);
    var out = new Float32Array(outLen);
    var i, pos, k;
    if (ratio < 1) {
      for (i = 0; i < outLen; i++) {
        pos = i * ratio;
        k = Math.floor(pos);
        var a = input[k];
        var b = k + 1 < n ? input[k + 1] : a;
        out[i] = a + (b - a) * (pos - k);
      }
      return out;
    }
    var K = sincKernels(ratio);
    for (i = 0; i < outLen; i++) {
      pos = i * ratio;
      k = Math.floor(pos);
      var phase = Math.min(K.phases - 1, Math.round((pos - k) * K.phases));
      var base = phase * K.width;
      var first = k - K.half + 1;
      var acc = 0;
      var wsum = 0;
      var edge = first < 0 || first + K.width > n;
      for (var j = 0; j < K.width; j++) {
        var idx = first + j;
        if (edge && (idx < 0 || idx >= n)) continue;
        var w = K.table[base + j];
        acc += input[idx] * w;
        wsum += w;
      }
      out[i] = edge ? (wsum ? acc / wsum : 0) : acc;
    }
    return out;
  }

  /** PCM16 mono WAV (RIFF, 44-byte header). Samples are clamped to [-1, 1]. */
  function encodeWav(samples, sampleRate) {
    var n = samples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buffer);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);          // fmt chunk size
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);           // block align
    v.setUint16(34, 16, true);          // bits per sample
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    for (var i = 0, off = 44; i < n; i++, off += 2) {
      var s = samples[i];
      s = s > 1 ? 1 : s < -1 ? -1 : s !== s ? 0 : s;
      v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    }
    return buffer;
  }

  function concat(blocks, total) {
    var out = new Float32Array(total);
    var off = 0;
    for (var i = 0; i < blocks.length; i++) {
      out.set(blocks[i], off);
      off += blocks[i].length;
    }
    return out;
  }

  /**
   * Index in [target - search, target] at the centre of the quietest short frame,
   * so chunk boundaries fall into pauses between words.
   */
  function findCutIndex(samples, sampleRate, target, searchSamples) {
    target = Math.min(target, samples.length);
    var frame = Math.max(1, Math.round(sampleRate * CUT_FRAME_SECONDS));
    var from = Math.max(0, target - Math.max(0, searchSamples | 0));
    if (target - from < frame) return target;
    var best = target;
    var bestEnergy = Infinity;
    for (var start = target - frame; start >= from; start -= frame) {
      var e = 0;
      for (var i = start; i < start + frame; i++) e += samples[i] * samples[i];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = start + (frame >> 1);
      }
    }
    return best;
  }

  // ------------------------------------------------------------ Chunker ---
  /** Accumulates blocks at `sampleRate`, emits ~chunkSeconds chunks cut in pauses. */
  function Chunker(sampleRate, chunkSeconds, onChunk) {
    this.rate = sampleRate;
    this.target = Math.max(1, Math.round(chunkSeconds * sampleRate));
    this.search = Math.round(Math.min(2, chunkSeconds * 0.25) * sampleRate);
    this.onChunk = onChunk;
    this.blocks = [];
    this.length = 0;
    this.consumed = 0; // samples already emitted or dropped (drives offsets)
  }
  Chunker.prototype.push = function (block) {
    if (!block || !block.length) return;
    this.blocks.push(block);
    this.length += block.length;
    while (this.length >= this.target) {
      var all = concat(this.blocks, this.length);
      var cut = findCutIndex(all, this.rate, this.target, this.search);
      if (cut <= 0) cut = this.target;
      this._emit(all.subarray(0, cut));
      var rest = all.slice(cut);
      this.blocks = rest.length ? [rest] : [];
      this.length = rest.length;
    }
  };
  Chunker.prototype._emit = function (samples) {
    var start = this.consumed;
    this.consumed += samples.length;
    this.onChunk({ samples: samples, sampleRate: this.rate, startSample: start });
  };
  /** Emits the remainder if it is at least `minSeconds` long; drops it otherwise. */
  Chunker.prototype.flush = function (minSeconds) {
    if (!this.length) return;
    var all = concat(this.blocks, this.length);
    this.blocks = [];
    this.length = 0;
    if (all.length >= (minSeconds || 0) * this.rate) this._emit(all);
    else this.consumed += all.length;
  };

  // ----------------------------------------------------------- Uploader ---
  var MESSAGES = {
    401: 'Нет доступа к серверу Recapper (неверный токен).',
    404: 'Сессия записи не найдена на сервере.',
    409: 'Сессия уже завершена — запись остановлена.',
    503: 'Распознавание речи на сервере не настроено.',
    network: 'Нет связи с сервером Recapper.',
  };
  var FATAL_STATUSES = { 401: 'unauthorized', 404: 'session_not_found', 409: 'session_closed', 503: 'asr_unavailable' };

  function captureError(message, props) {
    var err = new Error(message);
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) err[k] = props[k];
    return err;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function readDetail(res) {
    return res.text().then(function (text) {
      try {
        var body = JSON.parse(text);
        var d = body && body.detail;
        if (typeof d === 'string') return d;
        if (d) return JSON.stringify(d);
      } catch (e) { /* not JSON */ }
      return (text || '').slice(0, 300);
    }, function () { return ''; });
  }

  /**
   * Serialized upload queue for one source: chunk N+1 is sent only after chunk N
   * finished, so the backend receives them in order.
   */
  function Uploader(o) {
    this.o = o; // {url, token, source, fetch, onResult, onError, onWarning, retryDelayMs}
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.waiters = [];
    this.stats = { sent: 0, failed: 0, dropped: 0, retried: 0 };
  }
  Uploader.prototype.enqueue = function (item) {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.stats.dropped++;
      if (this.o.onWarning) this.o.onWarning('queue_overflow', 'Сервер не успевает обрабатывать звук (' + this.o.source + '): старые фрагменты пропущены.');
    }
    this.queue.push(item);
    this._pump();
  };
  Uploader.prototype._pump = function () {
    if (this.busy) return;
    var self = this;
    this.busy = true;
    (async function () {
      while (self.queue.length && !self.closed) {
        var item = self.queue.shift();
        try { await self._send(item); } catch (e) { /* _send reports its own errors */ }
      }
      self.busy = false;
      var w = self.waiters;
      self.waiters = [];
      w.forEach(function (fn) { fn(); });
    })();
  };
  Uploader.prototype._send = async function (item) {
    var o = this.o;
    var form = new FormData();
    form.append('file', new Blob([item.wav], { type: 'audio/wav' }), o.source + '-' + item.seq + '.wav');
    form.append('source', o.source);
    form.append('offset', item.offset.toFixed(3));
    form.append('duration', item.duration.toFixed(3));
    form.append('seq', String(item.seq));
    var headers = {};
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    var meta = { source: o.source, offset: item.offset, duration: item.duration, seq: item.seq };
    for (var attempt = 0; attempt < 2; attempt++) {
      var res;
      try {
        res = await o.fetch(o.url, { method: 'POST', headers: headers, body: form });
      } catch (netErr) {
        if (attempt === 0 && !this.closed) {
          this.stats.retried++;
          await sleep(o.retryDelayMs == null ? RETRY_DELAY_MS : o.retryDelayMs);
          continue;
        }
        this.stats.failed++;
        o.onError(captureError(MESSAGES.network + ' ' + ((netErr && netErr.message) || ''), {
          code: 'network', status: 0, source: o.source, fatal: false, chunk: meta,
        }));
        return;
      }
      if (res.ok) {
        var body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        this.stats.sent++;
        if (o.onResult) o.onResult(body, meta);
        return;
      }
      var detail = await readDetail(res);
      this.stats.failed++;
      var code = FATAL_STATUSES[res.status] || 'http_' + res.status;
      var base = MESSAGES[res.status] || ('Ошибка сервера ' + res.status + '.');
      o.onError(captureError(detail ? base + ' ' + detail : base, {
        code: code, status: res.status, source: o.source, fatal: Boolean(FATAL_STATUSES[res.status]), chunk: meta,
      }));
      return;
    }
  };
  /** Resolves when everything queued so far is sent (or `timeoutMs` passes). */
  Uploader.prototype.drain = function (timeoutMs) {
    var self = this;
    if (!this.busy && !this.queue.length) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(false); }, timeoutMs || DRAIN_TIMEOUT_MS);
      self.waiters.push(function () { clearTimeout(t); resolve(true); });
    });
  };
  Uploader.prototype.close = function () {
    this.closed = true;
    this.queue = [];
  };

  // ------------------------------------------------------------- options ---
  function normalizeSources(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    list.forEach(function (s) { if (KNOWN_SOURCES.indexOf(s) >= 0 && out.indexOf(s) < 0) out.push(s); });
    return out.length ? out : null;
  }

  /** Explicit options win; then backend settings; then built-in defaults. */
  function resolveOptions(opts, values) {
    values = values || {};
    var chunkRaw = opts.chunkSeconds != null ? opts.chunkSeconds : values.capture_chunk_seconds;
    var chunk = Number(chunkRaw);
    if (chunkRaw == null || !(chunk >= 1 && chunk <= 300)) chunk = DEFAULTS.chunkSeconds;
    var sources = normalizeSources(opts.sources) || (opts.sources == null ? normalizeSources(values.capture_sources) : null) || DEFAULTS.sources.slice();
    var thrRaw = opts.silenceThreshold != null ? opts.silenceThreshold : values.capture_silence_threshold;
    var thr = Number(thrRaw);
    if (thrRaw == null || thrRaw === '' || !(thr >= 0 && thr < 1)) thr = DEFAULTS.silenceThreshold;
    return { chunkSeconds: chunk, sources: sources, silenceThreshold: thr };
  }

  async function fetchSettings(baseUrl, token, fetchImpl) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, SETTINGS_TIMEOUT_MS);
    try {
      var headers = token ? { Authorization: 'Bearer ' + token } : {};
      var res = await fetchImpl(baseUrl + '/api/settings', { headers: headers, signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) return null;
      var body = await res.json();
      return body && body.values && typeof body.values === 'object' ? body.values : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------- media input ---
  var WORKLET_SOURCE =
    'class RecapperCaptureProcessor extends AudioWorkletProcessor {\n' +
    '  constructor() { super(); this.buf = new Float32Array(' + WORKLET_BLOCK + '); this.n = 0;\n' +
    '    this.port.onmessage = (e) => { if (e.data === "flush") { this.post(); this.port.postMessage("flushed"); } }; }\n' +
    '  post() { if (!this.n) return; const out = this.buf.slice(0, this.n); this.n = 0; this.port.postMessage(out, [out.buffer]); }\n' +
    '  process(inputs) { const ch = inputs[0] && inputs[0][0];\n' +
    '    if (ch) { for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) this.post(); } }\n' +
    '    return true; }\n' +
    '}\n' +
    'registerProcessor("recapper-capture", RecapperCaptureProcessor);\n';

  function withTimeout(promise, ms, onLate) {
    var timedOut = false;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        timedOut = true;
        reject(captureError('timeout after ' + ms + ' ms', { code: 'timeout' }));
      }, ms);
      promise.then(function (v) {
        clearTimeout(t);
        if (timedOut) { if (onLate) onLate(v); } else resolve(v);
      }, function (e) {
        clearTimeout(t);
        if (!timedOut) reject(e);
      });
    });
  }

  function stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
  }

  function micStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
  }

  async function systemStream(bridge, timeoutMs) {
    var md = navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function') {
      throw captureError('getDisplayMedia не поддерживается', { code: 'unsupported' });
    }
    var stream;
    if (bridge && typeof bridge.enableLoopbackAudio === 'function') {
      await bridge.enableLoopbackAudio();
      try {
        stream = await withTimeout(md.getDisplayMedia({ video: true, audio: true }), timeoutMs || DISPLAY_MEDIA_TIMEOUT_MS, stopStream);
      } finally {
        try { await bridge.disableLoopbackAudio(); } catch (e) { /* ignore */ }
      }
    } else {
      stream = await md.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
    }
    stream.getVideoTracks().forEach(function (t) { t.stop(); stream.removeTrack(t); });
    if (!stream.getAudioTracks().length) {
      stopStream(stream);
      throw captureError('в выбранном источнике нет звука', { code: 'no_audio_track' });
    }
    return stream;
  }

  function systemHint(bridge) {
    if (bridge && bridge.platform === 'darwin') {
      return ' Разрешите Recapper «Запись экрана и системного звука» в Системных настройках → Конфиденциальность и безопасность и перезапустите приложение.';
    }
    if (bridge) return '';
    return ' В окне выбора укажите вкладку со звонком и включите «Поделиться звуком вкладки».';
  }

  /** One source: stream → AudioContext → worklet/ScriptProcessor → Chunker → WAV → Uploader. */
  function Pipeline(kind, stream, cfg) {
    this.kind = kind;
    this.stream = stream;
    this.cfg = cfg; // {chunkSeconds, silenceThreshold, t0, uploader, workletUrl, onWarning, onEnded}
    this.ctx = null;
    this.node = null;
    this.sink = null;
    this.src = null;
    this.chunker = null;
    this.mode = null;
    this.startOffset = null;
    this.seq = 0;
    this.skipped = 0;
    this.stopped = false;
    this.heard = false;      // any non-silent sample seen yet
    this.silenceTimer = null;
    this.paused = false;
    this.meanSquare = 0;     // smoothed power for the level meter
    this.lastBlockAt = 0;
  }

  /** Current meter value 0..1 (see levelFromRms). */
  Pipeline.prototype.level = function (now) {
    if (!this.lastBlockAt || now - this.lastBlockAt > LEVEL_STALE_MS) return 0;
    return levelFromRms(Math.sqrt(this.meanSquare));
  };

  /** Pause: upload what was recorded so far, then drop audio until resume(). */
  Pipeline.prototype.pause = function () {
    if (this.paused || this.stopped) return;
    this.paused = true;
    if (this.chunker) this.chunker.flush(MIN_FLUSH_SECONDS);
  };

  Pipeline.prototype.resume = function () {
    this.paused = false;
  };

  Pipeline.prototype.start = async function () {
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) throw captureError('Web Audio API недоступен', { code: 'unsupported' });
    var ctx;
    try { ctx = new AC({ sampleRate: TARGET_RATE, latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    var src;
    try {
      src = ctx.createMediaStreamSource(this.stream);
    } catch (e) {
      // Firefox cannot connect a stream to a context with a different rate.
      try { ctx.close(); } catch (e2) { /* ignore */ }
      ctx = new AC();
      src = ctx.createMediaStreamSource(this.stream);
    }
    this.ctx = ctx;
    this.src = src;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* resumes on next gesture */ } }
    var self = this;
    this.chunker = new Chunker(ctx.sampleRate, this.cfg.chunkSeconds, function (c) { self._onChunk(c); });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0; // keep the graph pulled without playing anything back
    this.sink.connect(ctx.destination);
    var node = null;
    if (ctx.audioWorklet && typeof root.AudioWorkletNode === 'function' && this.cfg.workletUrl) {
      try {
        await ctx.audioWorklet.addModule(this.cfg.workletUrl);
        node = new root.AudioWorkletNode(ctx, 'recapper-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        });
        node.port.onmessage = function (e) {
          if (e.data === 'flushed') { if (self._flushed) self._flushed(); return; }
          self._onBlock(e.data);
        };
        this.mode = 'worklet';
      } catch (e) {
        node = null;
      }
    }
    if (!node) {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (e) {
        self._onBlock(new Float32Array(e.inputBuffer.getChannelData(0)));
        e.outputBuffer.getChannelData(0).fill(0);
      };
      this.mode = 'script-processor';
    }
    this.node = node;
    src.connect(node);
    node.connect(this.sink);
    this.stream.getAudioTracks().forEach(function (t) {
      t.addEventListener('ended', function () { if (!self.stopped && self.cfg.onEnded) self.cfg.onEnded(self.kind); });
    });
    if (this.cfg.silenceWarnMs > 0) {
      // No samples or only zeros: macOS without the permission, a muted device,
      // Linux without PulseAudio... Tell the user once; capture keeps running.
      this.silenceTimer = setTimeout(function () {
        if (!self.heard && !self.stopped && self.cfg.onSilent) self.cfg.onSilent(self.kind);
      }, this.cfg.silenceWarnMs);
    }
    return { sampleRate: ctx.sampleRate, mode: this.mode };
  };

  Pipeline.prototype._onBlock = function (block) {
    if (this.stopped && !this._flushing) return;
    if (!this.heard) {
      for (var i = 0; i < block.length; i++) {
        if (block[i] > DIGITAL_SILENCE || block[i] < -DIGITAL_SILENCE) { this.heard = true; break; }
      }
    }
    var t = root.performance ? root.performance.now() : Date.now();
    if (block.length) {
      var sum = 0;
      for (var j = 0; j < block.length; j++) sum += block[j] * block[j];
      var dur = block.length / this.ctx.sampleRate;
      var alpha = 1 - Math.exp(-dur / LEVEL_WINDOW_S);
      this.meanSquare += alpha * (sum / block.length - this.meanSquare);
      this.lastBlockAt = t;
    }
    if (this.startOffset === null) {
      this.startOffset = Math.max(0, (t - this.cfg.t0) / 1000 - block.length / this.ctx.sampleRate);
    }
    if (this.paused) {
      // Dropped, but the clock keeps running: offsets stay on the meeting timeline.
      this.chunker.consumed += block.length;
      return;
    }
    this.chunker.push(block);
  };

  Pipeline.prototype._onChunk = function (c) {
    var pcm = downsample(c.samples, c.sampleRate, TARGET_RATE);
    var offset = (this.startOffset || 0) + c.startSample / c.sampleRate;
    var duration = pcm.length / TARGET_RATE;
    if (isSilent(pcm, TARGET_RATE, this.cfg.silenceThreshold)) {
      this.skipped++;
      return;
    }
    this.cfg.uploader.enqueue({ wav: encodeWav(pcm, TARGET_RATE), offset: offset, duration: duration, seq: this.seq++ });
  };

  /** Stops capturing; with flush=true the partial chunk is uploaded first. */
  Pipeline.prototype.stop = async function (flush) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.silenceTimer);
    var self = this;
    if (flush && this.node && this.mode === 'worklet') {
      this._flushing = true;
      await new Promise(function (resolve) {
        var t = setTimeout(resolve, 300);
        self._flushed = function () { clearTimeout(t); resolve(); };
        try { self.node.port.postMessage('flush'); } catch (e) { clearTimeout(t); resolve(); }
      });
      this._flushing = false;
    }
    if (flush && this.chunker) this.chunker.flush(MIN_FLUSH_SECONDS);
    try { if (this.src) this.src.disconnect(); } catch (e) { /* ignore */ }
    try { if (this.node) this.node.disconnect(); } catch (e) { /* ignore */ }
    if (this.node && this.node.port) this.node.port.onmessage = null;
    if (this.node && this.mode === 'script-processor') this.node.onaudioprocess = null;
    stopStream(this.stream);
    if (this.ctx && this.ctx.state !== 'closed') { try { await this.ctx.close(); } catch (e) { /* ignore */ } }
  };

  // ------------------------------------------------------------ controller ---
  var current = null;   // active capture session
  var stopping = null;  // promise of an in-progress stop()

  function bridge() { return root.recapperDesktop || null; }

  function status(s, state, level, code, message) {
    var detail = { state: state, level: level || 'info', code: code || state, message: message || '', sources: s ? sourceStates(s) : {} };
    if (s && s.onStatus) { try { s.onStatus(detail.message, detail); } catch (e) { /* user callback */ } }
  }

  function sourceStates(s) {
    var out = {};
    s.requested.forEach(function (k) { out[k] = s.sourceState[k] || 'off'; });
    return out;
  }

  function setDesktopCapturing(on) {
    var b = bridge();
    if (b && typeof b.setCapturing === 'function') { try { b.setCapturing(on).catch(function () {}); } catch (e) { /* ignore */ } }
  }

  async function start(options) {
    var opts = options || {};
    if (stopping) await stopping;
    if (current) throw captureError('Запись уже идёт', { code: 'already_running' });
    if (!opts.sessionId) throw captureError('sessionId обязателен', { code: 'bad_options' });
    var fetchImpl = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    if (!fetchImpl) throw captureError('fetch недоступен', { code: 'unsupported' });
    var md = root.navigator && root.navigator.mediaDevices;
    if (!md) throw captureError('Захват звука недоступен: нужен HTTPS или localhost', { code: 'unsupported' });

    var s = {
      id: opts.sessionId,
      token: opts.token || '',
      baseUrl: (opts.baseUrl || '').replace(/\/+$/, ''),
      onStatus: opts.onStatus,
      onError: opts.onError,
      onResult: opts.onResult,
      requested: [],
      sourceState: {},
      streams: [],
      pipelines: {},
      uploaders: {},
      warnings: [],
      active: false,
      cancelled: false,
      fatal: false,
      t0: now(),
      workletUrl: null,
      onLevel: typeof opts.onLevel === 'function' ? opts.onLevel : null,
      levelTimer: null,
      activeSince: 0,
      paused: false,
      pausedAt: 0,
      pausedTotal: 0,
    };
    current = s;
    var starting = (async function () {
      var needSettings = opts.chunkSeconds == null || opts.sources == null || opts.silenceThreshold == null;
      var values = needSettings ? await fetchSettings(s.baseUrl, s.token, fetchImpl) : null;
      var cfg = resolveOptions(opts, values);
      s.config = cfg;
      s.requested = cfg.sources.slice();
      status(s, 'starting', 'info', 'starting', 'Подключаю источники звука…');

      var b = bridge();
      var acquire = {
        mic: function () { return micStream(); },
        system: function () { return systemStream(b, opts.systemTimeoutMs); },
      };
      var results = {};
      var order = s.requested.slice();
      if (!b) {
        // Browser: the tab picker needs the click's user activation, so ask for it first.
        order = order.filter(function (k) { return k === 'system'; })
          .concat(order.filter(function (k) { return k !== 'system'; }));
        for (var i = 0; i < order.length; i++) {
          try { results[order[i]] = { stream: await acquire[order[i]]() }; } catch (e) { results[order[i]] = { error: e }; }
        }
      } else {
        await Promise.all(order.map(function (k) {
          return acquire[k]().then(function (st) { results[k] = { stream: st }; }, function (e) { results[k] = { error: e }; });
        }));
      }
      order.forEach(function (k) { if (results[k].stream) s.streams.push(results[k].stream); });
      if (s.cancelled) throw captureError('Запись отменена', { code: 'cancelled' });

      if (typeof Blob !== 'undefined' && root.URL && root.URL.createObjectURL) {
        try { s.workletUrl = root.URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' })); } catch (e) { s.workletUrl = null; }
      }
      var info = { sources: [], warnings: [], sampleRates: {}, modes: {} };
      var url = s.baseUrl + '/api/live/' + encodeURIComponent(s.id) + '/audio';
      for (var j = 0; j < s.requested.length; j++) {
        var kind = s.requested[j];
        var r = results[kind];
        if (r.error) {
          s.sourceState[kind] = 'failed';
          var msg = kind === 'system'
            ? 'Системный звук недоступен (' + (r.error.message || r.error.name) + '). Продолжаю только с микрофоном.' + systemHint(b)
            : 'Микрофон недоступен (' + (r.error.message || r.error.name) + ').';
          if (kind === 'system' && s.requested.indexOf('mic') < 0) msg = 'Системный звук недоступен (' + (r.error.message || r.error.name) + ').' + systemHint(b);
          s.warnings.push({ source: kind, code: kind + '_unavailable', message: msg });
          continue;
        }
        var up = new Uploader({
          url: url, token: s.token, source: kind, fetch: fetchImpl,
          onResult: function (body, meta) { if (s.onResult) { try { s.onResult(body, meta); } catch (e) { /* user callback */ } } },
          onError: function (err) { handleUploadError(s, err); },
          onWarning: function (code, message) { status(s, 'warning', 'warning', code, message); },
        });
        s.uploaders[kind] = up;
        var p = new Pipeline(kind, r.stream, {
          chunkSeconds: cfg.chunkSeconds, silenceThreshold: cfg.silenceThreshold, t0: s.t0,
          uploader: up, workletUrl: s.workletUrl, onEnded: function (k) { onTrackEnded(s, k); },
          silenceWarnMs: opts.silenceWarnMs == null ? SILENCE_WARN_MS : Number(opts.silenceWarnMs),
          onSilent: function (k) { onSourceSilent(s, k, b); },
        });
        s.pipelines[kind] = p;
        var pinfo = await p.start();
        s.sourceState[kind] = 'on';
        info.sources.push(kind);
        info.sampleRates[kind] = pinfo.sampleRate;
        info.modes[kind] = pinfo.mode;
        if (s.cancelled) throw captureError('Запись отменена', { code: 'cancelled' });
      }
      if (!info.sources.length) {
        var reasons = s.warnings.map(function (w) { return w.message; }).join(' ');
        throw captureError('Не удалось подключить ни один источник звука. ' + reasons, { code: 'no_sources' });
      }
      info.warnings = s.warnings.slice();
      info.config = cfg;
      s.active = true;
      s.activeSince = now();
      if (s.onLevel) s.levelTimer = setInterval(function () { emitLevels(s); }, LEVEL_INTERVAL_MS);
      setDesktopCapturing(true);
      s.warnings.forEach(function (w) { status(s, 'warning', 'warning', w.code, w.message); });
      status(s, 'running', 'info', 'running', 'Идёт запись: ' + info.sources.map(function (k) { return k === 'mic' ? 'микрофон' : 'системный звук'; }).join(' + '));
      return info;
    })();
    s.starting = starting;
    try {
      return await starting;
    } catch (err) {
      await teardown(s, false);
      if (current === s) current = null;
      throw err;
    }
  }

  function now() { return root.performance ? root.performance.now() : Date.now(); }

  /** {mic, system}: 0..1 for active sources, null for sources not captured. */
  function currentLevels(s) {
    var t = now();
    var out = { mic: null, system: null };
    KNOWN_SOURCES.forEach(function (k) {
      var p = s.pipelines[k];
      if (p && !p.stopped && s.sourceState[k] === 'on') out[k] = p.level(t);
    });
    return out;
  }

  function emitLevels(s) {
    if (!s.active || !s.onLevel) return;
    try { s.onLevel(currentLevels(s)); } catch (e) { /* user callback */ }
  }

  function handleUploadError(s, err) {
    if (s.onError) { try { s.onError(err); } catch (e) { /* user callback */ } }
    if (err.fatal && !s.fatal) {
      s.fatal = true;
      status(s, 'warning', 'error', err.code, err.message);
      // Nothing more can be delivered to this session: stop without flushing.
      Promise.resolve().then(function () { if (current === s) stop(); });
    }
  }

  function onSourceSilent(s, kind, b) {
    var msg;
    if (kind === 'system') {
      var others = s.requested.indexOf('mic') >= 0 && s.sourceState.mic === 'on' ? ' Запись с микрофона продолжается.' : '';
      msg = 'Системный звук пока не поступает (тишина).' + others +
        (systemHint(b) || ' Если собеседники уже говорят, проверьте устройство вывода звука.');
    } else {
      msg = 'Микрофон передаёт тишину: проверьте, что он не выключен и у Recapper есть доступ к микрофону.';
    }
    s.warnings.push({ source: kind, code: kind + '_silent', message: msg });
    status(s, 'warning', 'warning', kind + '_silent', msg);
  }

  function onTrackEnded(s, kind) {
    s.sourceState[kind] = 'ended';
    var p = s.pipelines[kind];
    var label = kind === 'mic' ? 'Микрофон отключён.' : 'Захват системного звука остановлен.';
    status(s, 'warning', 'warning', kind + '_ended', label);
    if (p) p.stop(true);
    var anyOn = s.requested.some(function (k) { return s.sourceState[k] === 'on'; });
    if (!anyOn && current === s) stop();
  }

  async function teardown(s, flush) {
    s.cancelled = true;
    s.active = false;
    if (s.levelTimer) { clearInterval(s.levelTimer); s.levelTimer = null; }
    var kinds = Object.keys(s.pipelines);
    await Promise.all(kinds.map(function (k) { return s.pipelines[k].stop(flush && !s.fatal).catch(function () {}); }));
    s.streams.forEach(stopStream);
    var ups = Object.keys(s.uploaders).map(function (k) { return s.uploaders[k]; });
    if (flush && !s.fatal) await Promise.all(ups.map(function (u) { return u.drain(DRAIN_TIMEOUT_MS); }));
    ups.forEach(function (u) { u.close(); });
    if (s.workletUrl) { try { root.URL.revokeObjectURL(s.workletUrl); } catch (e) { /* ignore */ } }
    setDesktopCapturing(false);
  }

  /** Stops capture: uploads the last partial chunk, waits for uploads, releases devices. */
  function stop() {
    if (stopping) return stopping;
    var s = current;
    if (!s) return Promise.resolve();
    stopping = (async function () {
      s.cancelled = true;
      if (s.starting) { try { await s.starting; } catch (e) { /* start() cleans up after itself */ } }
      if (current !== s) return; // start() failed and already tore down
      status(s, 'stopping', 'info', 'stopping', 'Останавливаю запись…');
      await teardown(s, true);
      current = null;
      var st = {};
      Object.keys(s.uploaders).forEach(function (k) {
        st[k] = Object.assign({ skipped: s.pipelines[k] ? s.pipelines[k].skipped : 0, heard: Boolean(s.pipelines[k] && s.pipelines[k].heard) }, s.uploaders[k].stats);
      });
      s.finalStats = st;
      lastStats = st;
      status(s, 'stopped', 'info', 'stopped', 'Запись остановлена.');
    })().finally(function () { stopping = null; });
    return stopping;
  }

  /** Pauses sending audio (devices stay open, meters keep working). Resolves true if paused. */
  async function pause() {
    var s = current;
    if (!s || !s.active || s.paused) return false;
    s.paused = true;
    s.pausedAt = now();
    Object.keys(s.pipelines).forEach(function (k) { s.pipelines[k].pause(); });
    setDesktopCapturing(false);
    status(s, 'paused', 'info', 'paused', 'Запись на паузе: звук не отправляется.');
    return true;
  }

  async function resume() {
    var s = current;
    if (!s || !s.active || !s.paused) return false;
    s.pausedTotal += now() - s.pausedAt;
    s.paused = false;
    Object.keys(s.pipelines).forEach(function (k) { s.pipelines[k].resume(); });
    setDesktopCapturing(true);
    status(s, 'running', 'info', 'resumed', 'Запись продолжена.');
    return true;
  }

  /** Seconds of recording since start() succeeded, excluding pauses; 0 when not running. */
  function elapsed() {
    var s = current;
    if (!s || !s.active) return 0;
    var end = s.paused ? s.pausedAt : now();
    return Math.max(0, (end - s.activeSince - s.pausedTotal) / 1000);
  }

  var lastStats = null;
  function stats() {
    var s = current;
    if (!s) return lastStats;
    var out = {};
    Object.keys(s.uploaders).forEach(function (k) {
      var p = s.pipelines[k];
      out[k] = Object.assign({ skipped: p ? p.skipped : 0, heard: Boolean(p && p.heard), queued: s.uploaders[k].queue.length }, s.uploaders[k].stats);
    });
    return out;
  }

  var api = {
    get isDesktop() { return Boolean(root.recapperDesktop); },
    get running() { return Boolean(current && current.active); },
    get paused() { return Boolean(current && current.active && current.paused); },
    get sources() { return current ? sourceStates(current) : {}; },
    get levels() { return current && current.active ? currentLevels(current) : { mic: null, system: null }; },
    start: start,
    stop: stop,
    pause: pause,
    resume: resume,
    elapsed: elapsed,
    stats: stats,
    TARGET_RATE: TARGET_RATE,
    DEFAULTS: DEFAULTS,
    _internals: {
      encodeWav: encodeWav,
      downsample: downsample,
      rms: rms,
      peakFrameRms: peakFrameRms,
      isSilent: isSilent,
      findCutIndex: findCutIndex,
      Chunker: Chunker,
      Uploader: Uploader,
      resolveOptions: resolveOptions,
      fetchSettings: fetchSettings,
      withTimeout: withTimeout,
      levelFromRms: levelFromRms,
    },
  };
  root.RecapperCapture = api;
})(typeof window !== 'undefined' ? window : globalThis);
