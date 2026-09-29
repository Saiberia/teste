'use strict';
// Desktop-relevant user settings (served by the backend at GET /api/settings).
// Pure functions only; unit-tested with `node --test`.

const DEFAULT_SETTINGS = Object.freeze({
  ui_language: 'ru',
  capture_chunk_seconds: 12,
  capture_sources: Object.freeze(['mic', 'system']),
  capture_silence_threshold: 0.004,
  panel_hotkey: 'CommandOrControl+Shift+R',
  panel_always_on_top: true,
  panel_hide_from_screen_share: true,
  theme: 'system',
});

const LANGUAGES = ['ru', 'en'];
const THEMES = ['system', 'light', 'dark'];
const SOURCES = ['mic', 'system'];

const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

const NAMED_KEYS = new Set([
  'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace', 'delete', 'insert',
  'return', 'enter', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'escape', 'esc', 'volumeup', 'volumedown', 'volumemute', 'medianexttrack', 'mediaprevioustrack',
  'mediastop', 'mediaplaypause', 'printscreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
]);
// Keys that are fine as a global shortcut without a modifier.
const STANDALONE_KEYS = /^(f([1-9]|1[0-9]|2[0-4])|media\w+|volume\w+)$/i;
const PUNCTUATION = new Set([...')!@#$%^&*(:;<=>,_-.?/~`{}[]|\\\'"']);

function isKeyCode(k) {
  const lower = k.toLowerCase();
  if (/^[a-z0-9]$/i.test(k)) return true;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(k)) return true;
  if (NAMED_KEYS.has(lower)) return true;
  return k.length === 1 && PUNCTUATION.has(k);
}

/**
 * Validates an Electron accelerator for use as a *global* shortcut:
 * exactly one key code, known modifiers, no duplicates, and at least one
 * modifier unless the key is F1–F24 or a media key.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateAccelerator(accel) {
  if (typeof accel !== 'string' || !accel.trim()) return { ok: false, error: 'пустое сочетание клавиш' };
  const s = accel.trim();
  if (s.length > 64) return { ok: false, error: 'слишком длинное сочетание клавиш' };
  // '+' is the separator, so the key "+" must be written as "Plus".
  const parts = s.split('+');
  if (parts.some((p) => p.trim() === '')) return { ok: false, error: `некорректное сочетание «${s}» (для клавиши + используйте Plus)` };
  const mods = [];
  const keys = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (MODIFIERS.has(p.toLowerCase())) mods.push(p.toLowerCase());
    else if (isKeyCode(p)) keys.push(p);
    else return { ok: false, error: `неизвестная клавиша «${p}»` };
  }
  if (keys.length !== 1) return { ok: false, error: `нужна ровно одна основная клавиша, а не ${keys.length}` };
  if (new Set(mods).size !== mods.length) return { ok: false, error: 'модификатор повторяется' };
  if (!mods.length && !STANDALONE_KEYS.test(keys[0])) {
    return { ok: false, error: 'глобальное сочетание должно содержать модификатор (Ctrl/Cmd/Alt/Shift)' };
  }
  return { ok: true };
}

function isValidAccelerator(accel) {
  return validateAccelerator(accel).ok;
}

function toBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

/**
 * Normalizes a (possibly partial / malformed) settings object over `base`.
 * Unknown keys are kept as-is (the backend owns the full schema); known keys
 * with invalid values fall back to `base`. The hotkey is NOT validated here:
 * applying it may fail at registration time and is handled by the caller.
 */
function normalizeSettings(values, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  if (!values || typeof values !== 'object') return out;
  for (const [k, v] of Object.entries(values)) {
    if (!(k in DEFAULT_SETTINGS)) out[k] = v;
  }
  if (LANGUAGES.includes(values.ui_language)) out.ui_language = values.ui_language;
  if (THEMES.includes(values.theme)) out.theme = values.theme;
  const chunk = Number(values.capture_chunk_seconds);
  if (values.capture_chunk_seconds !== undefined && Number.isFinite(chunk) && chunk >= 2 && chunk <= 120) {
    out.capture_chunk_seconds = Math.round(chunk);
  }
  const thr = Number(values.capture_silence_threshold);
  if (values.capture_silence_threshold !== undefined && Number.isFinite(thr) && thr >= 0 && thr < 1) {
    out.capture_silence_threshold = thr;
  }
  if (Array.isArray(values.capture_sources)) {
    const src = [...new Set(values.capture_sources.filter((x) => SOURCES.includes(x)))];
    if (src.length) out.capture_sources = src;
  }
  if (typeof values.panel_hotkey === 'string' && values.panel_hotkey.trim()) out.panel_hotkey = values.panel_hotkey.trim();
  out.panel_always_on_top = toBool(values.panel_always_on_top, out.panel_always_on_top);
  out.panel_hide_from_screen_share = toBool(values.panel_hide_from_screen_share, out.panel_hide_from_screen_share);
  return out;
}

/** Extracts `values` from a GET /api/settings response body. */
function settingsFromResponse(body) {
  if (body && typeof body === 'object' && body.values && typeof body.values === 'object') return body.values;
  return null;
}

module.exports = {
  DEFAULT_SETTINGS,
  LANGUAGES,
  THEMES,
  validateAccelerator,
  isValidAccelerator,
  normalizeSettings,
  settingsFromResponse,
};
