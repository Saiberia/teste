/*
 * Capture options: server settings (GET /api/settings → values) with safe
 * defaults. Pure: no browser or chrome.* APIs.
 */

export const CAPTURE_DEFAULTS = Object.freeze({ chunkSeconds: 12, silenceThreshold: 0.004 });
export const CHUNK_LIMITS = Object.freeze({ min: 2, max: 60 });

/**
 * @param {object|null} values  `values` of GET /api/settings
 * @returns {{chunkSeconds: number, silenceThreshold: number}}
 */
export function resolveCaptureOptions(values) {
  const v = values && typeof values === "object" ? values : {};
  let chunk = Number(v.capture_chunk_seconds);
  if (v.capture_chunk_seconds == null || v.capture_chunk_seconds === "" || !Number.isFinite(chunk)) {
    chunk = CAPTURE_DEFAULTS.chunkSeconds;
  }
  chunk = Math.min(CHUNK_LIMITS.max, Math.max(CHUNK_LIMITS.min, chunk));
  let thr = Number(v.capture_silence_threshold);
  if (v.capture_silence_threshold == null || v.capture_silence_threshold === "" || !(thr >= 0 && thr < 1)) {
    thr = CAPTURE_DEFAULTS.silenceThreshold;
  }
  return { chunkSeconds: chunk, silenceThreshold: thr };
}

/** Which sources to capture, given the user's toggles; order is stable (system first). */
export function selectedSources({ tab, mic }) {
  const out = [];
  if (tab) out.push("system");
  if (mic) out.push("mic");
  return out;
}
