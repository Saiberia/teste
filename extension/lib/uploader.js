/*
 * Upload queue for one audio source: WAV chunks are POSTed to
 * /api/live/{sid}/audio strictly in order (chunk N+1 only after chunk N
 * finished). A network error is retried once; HTTP errors are classified so
 * the side panel can explain them. Pure: `fetch` is injected, no chrome.* APIs.
 */

export const MAX_QUEUE = 40; // per source (~8 min of audio at 12 s chunks)
export const RETRY_DELAY_MS = 1000;

/** HTTP statuses after which nothing more can be delivered to this session. */
export const FATAL_STATUSES = Object.freeze({
  401: "unauthorized",
  404: "session_not_found",
  409: "session_closed",
  503: "asr_unavailable",
});

/** Error code for an HTTP status (or "network" for status 0). */
export function uploadErrorCode(status) {
  if (!status) return "network";
  return FATAL_STATUSES[status] || `http_${status}`;
}

export function isFatalStatus(status) {
  return Boolean(FATAL_STATUSES[status]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readDetail(res) {
  let text = "";
  try { text = await res.text(); } catch { return ""; }
  try {
    const body = JSON.parse(text);
    const d = body && body.detail;
    if (typeof d === "string") return d;
    if (d) return JSON.stringify(d);
  } catch { /* not JSON */ }
  return (text || "").slice(0, 300);
}

/** Multipart body the server expects: file (WAV), source, offset. */
export function buildAudioForm({ wav, source, offset, seq }) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), `${source}-${seq}.wav`);
  form.append("source", source);
  form.append("offset", Number(offset || 0).toFixed(3));
  return form;
}

export class Uploader {
  /**
   * @param {{url: string, token?: string, source: "mic"|"system", fetch: Function,
   *          onResult?: Function, onError: Function, onWarning?: Function, retryDelayMs?: number}} o
   */
  constructor(o) {
    this.o = o;
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.waiters = [];
    this.seq = 0;
    this.stats = { sent: 0, failed: 0, dropped: 0, retried: 0 };
  }

  enqueue(job) {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.stats.dropped++;
      this.o.onWarning?.("queue_overflow", { source: this.o.source });
    }
    this.queue.push({ ...job, seq: this.seq++ });
    this._pump();
  }

  _pump() {
    if (this.busy) return;
    this.busy = true;
    (async () => {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift();
        try { await this._send(job); } catch { /* _send reports its own errors */ }
      }
      this.busy = false;
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((fn) => fn());
    })();
  }

  async _send(job) {
    const o = this.o;
    const headers = o.token ? { Authorization: `Bearer ${o.token}` } : {};
    const meta = { source: o.source, offset: job.offset, duration: job.duration, seq: job.seq };
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        // A fresh body per attempt: a FormData stream cannot be reused reliably.
        res = await o.fetch(o.url, { method: "POST", headers, body: buildAudioForm({ ...job, source: o.source }) });
      } catch (netErr) {
        if (attempt === 0 && !this.closed) {
          this.stats.retried++;
          await sleep(o.retryDelayMs ?? RETRY_DELAY_MS);
          continue;
        }
        this.stats.failed++;
        o.onError({ code: "network", status: 0, source: o.source, fatal: false, detail: String(netErr?.message || netErr), chunk: meta });
        return;
      }
      if (res.ok) {
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        this.stats.sent++;
        o.onResult?.(body, meta);
        return;
      }
      const detail = await readDetail(res);
      this.stats.failed++;
      o.onError({ code: uploadErrorCode(res.status), status: res.status, source: o.source,
        fatal: isFatalStatus(res.status), detail, chunk: meta });
      return;
    }
  }

  /** Resolves true when everything queued so far is sent, false after `timeoutMs`. */
  drain(timeoutMs = 20000) {
    if (!this.busy && !this.queue.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  close() {
    this.closed = true;
    this.queue = [];
  }
}
