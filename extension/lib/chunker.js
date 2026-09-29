/*
 * Chunk scheduling: accumulate audio blocks, cut ~N-second chunks in pauses,
 * then turn each chunk into an upload job (16 kHz WAV + offset) or skip it as
 * silence. Pure: no browser or chrome.* APIs.
 */

import { isSilent, resample } from "./dsp.js";
import { encodeWav, TARGET_RATE } from "./wav.js";

export const CUT_FRAME_SECONDS = 0.02; // resolution when looking for a pause to cut at
export const MIN_FLUSH_SECONDS = 0.4; // shorter tails are dropped on stop

function concat(blocks, total) {
  const out = new Float32Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/**
 * Index in [target - search, target] at the centre of the quietest 20 ms
 * frame, so chunk boundaries fall into pauses between words.
 */
export function findCutIndex(samples, sampleRate, target, searchSamples) {
  target = Math.min(target, samples.length);
  const frame = Math.max(1, Math.round(sampleRate * CUT_FRAME_SECONDS));
  const from = Math.max(0, target - Math.max(0, searchSamples | 0));
  if (target - from < frame) return target;
  let best = target;
  let bestEnergy = Infinity;
  for (let start = target - frame; start >= from; start -= frame) {
    let e = 0;
    for (let i = start; i < start + frame; i++) e += samples[i] * samples[i];
    if (e < bestEnergy) {
      bestEnergy = e;
      best = start + (frame >> 1);
    }
  }
  return best;
}

/**
 * Accumulates blocks at `sampleRate` and calls `onChunk({samples, sampleRate, startSample})`
 * for every ~`chunkSeconds` of audio (cut up to min(2 s, 25 %) earlier, at the quietest moment).
 */
export class Chunker {
  constructor(sampleRate, chunkSeconds, onChunk) {
    if (!(sampleRate > 0)) throw new RangeError("sampleRate must be positive");
    this.rate = sampleRate;
    this.target = Math.max(1, Math.round(chunkSeconds * sampleRate));
    this.search = Math.round(Math.min(2, chunkSeconds * 0.25) * sampleRate);
    this.onChunk = onChunk;
    this.blocks = [];
    this.length = 0;
    this.consumed = 0; // samples already emitted or dropped (drives offsets)
  }

  push(block) {
    if (!block || !block.length) return;
    this.blocks.push(block);
    this.length += block.length;
    while (this.length >= this.target) {
      const all = concat(this.blocks, this.length);
      let cut = findCutIndex(all, this.rate, this.target, this.search);
      if (cut <= 0) cut = this.target;
      this._emit(all.subarray(0, cut));
      const rest = all.slice(cut);
      this.blocks = rest.length ? [rest] : [];
      this.length = rest.length;
    }
  }

  /** Emits the remainder when it is at least `minSeconds` long; drops it otherwise. */
  flush(minSeconds = MIN_FLUSH_SECONDS) {
    if (!this.length) return;
    const all = concat(this.blocks, this.length);
    this.blocks = [];
    this.length = 0;
    if (all.length >= minSeconds * this.rate) this._emit(all);
    else this.consumed += all.length;
  }

  _emit(samples) {
    const start = this.consumed;
    this.consumed += samples.length;
    this.onChunk({ samples, sampleRate: this.rate, startSample: start });
  }
}

/**
 * Turns a chunk into an upload job.
 * @param {{samples: Float32Array, sampleRate: number, startSample: number}} chunk
 * @param {{startOffset?: number, silenceThreshold: number}} opts  startOffset: seconds between
 *        capture start and the first sample of this source
 * @returns {{skip: true, offset: number, duration: number} |
 *           {skip: false, wav: ArrayBuffer, offset: number, duration: number}}
 */
export function prepareChunk(chunk, { startOffset = 0, silenceThreshold }) {
  const pcm = resample(chunk.samples, chunk.sampleRate, TARGET_RATE);
  const offset = Math.max(0, startOffset) + chunk.startSample / chunk.sampleRate;
  const duration = pcm.length / TARGET_RATE;
  if (isSilent(pcm, TARGET_RATE, silenceThreshold)) return { skip: true, offset, duration };
  return { skip: false, wav: encodeWav(pcm, TARGET_RATE), offset, duration };
}
