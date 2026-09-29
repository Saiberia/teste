/*
 * Audio math used by the capture pipeline: resampling to 16 kHz, RMS and
 * silence detection. Pure: no browser or chrome.* APIs.
 */

export const SILENCE_FRAME_SECONDS = 0.1;

/** Root mean square of a block of samples (0 for an empty block). */
export function rms(samples) {
  const n = samples ? samples.length : 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/** Loudest RMS over consecutive frames of `frameSeconds` (0.1 s by default). */
export function peakFrameRms(samples, sampleRate, frameSeconds = SILENCE_FRAME_SECONDS) {
  const frame = Math.max(1, Math.round(sampleRate * frameSeconds));
  let peak = 0;
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const r = Math.sqrt(sum / (end - start));
    if (r > peak) peak = r;
  }
  return peak;
}

/**
 * A chunk is silent when no 100 ms frame has an RMS at or above `threshold`.
 * (Per-frame rather than whole-chunk RMS, so one short phrase in a long quiet
 * chunk still counts as speech.)
 */
export function isSilent(samples, sampleRate, threshold) {
  if (!samples || !samples.length) return true;
  return peakFrameRms(samples, sampleRate, SILENCE_FRAME_SECONDS) < threshold;
}

/** Number of output samples `resample` produces. */
export function resampledLength(inputLength, fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("sample rates must be positive");
  if (fromRate === toRate) return inputLength;
  return Math.floor((inputLength * toRate) / fromRate);
}

const kernelCache = new Map();
/** Windowed-sinc (Hann) low-pass kernels, quantized to 64 fractional phases. */
function sincKernels(ratio) {
  const key = ratio.toFixed(6);
  if (kernelCache.has(key)) return kernelCache.get(key);
  const PHASES = 64;
  const half = Math.ceil(8 * ratio);
  const cutoff = (0.9 * 0.5) / ratio; // cycles per input sample (~7.2 kHz for a 16 kHz output)
  const width = 2 * half;
  const table = new Float32Array(PHASES * width);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < width; j++) {
      const t = j - half + 1 - frac; // distance of the tap from the exact output position
      const x = 2 * cutoff * t;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = Math.abs(t) >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * t) / half);
      table[p * width + j] = sinc * w;
      sum += sinc * w;
    }
    for (let j = 0; j < width; j++) table[p * width + j] /= sum; // unity gain at DC
  }
  const k = { table, half, width, phases: PHASES };
  kernelCache.set(key, k);
  return k;
}

/**
 * Resamples mono float audio. Downsampling applies an anti-aliasing
 * windowed-sinc low-pass; upsampling interpolates linearly.
 * @returns {Float32Array} of length `resampledLength(input.length, fromRate, toRate)`
 */
export function resample(input, fromRate, toRate) {
  const outLen = resampledLength(input.length, fromRate, toRate);
  if (fromRate === toRate) return Float32Array.from(input);
  const n = input.length;
  const ratio = fromRate / toRate;
  const out = new Float32Array(outLen);
  if (ratio < 1) {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const k = Math.floor(pos);
      const a = input[k];
      const b = k + 1 < n ? input[k + 1] : a;
      out[i] = a + (b - a) * (pos - k);
    }
    return out;
  }
  const K = sincKernels(ratio);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const k = Math.floor(pos);
    const phase = Math.min(K.phases - 1, Math.round((pos - k) * K.phases));
    const base = phase * K.width;
    const first = k - K.half + 1;
    const edge = first < 0 || first + K.width > n;
    let acc = 0;
    let wsum = 0;
    for (let j = 0; j < K.width; j++) {
      const idx = first + j;
      if (edge && (idx < 0 || idx >= n)) continue;
      const w = K.table[base + j];
      acc += input[idx] * w;
      wsum += w;
    }
    out[i] = edge ? (wsum ? acc / wsum : 0) : acc;
  }
  return out;
}
