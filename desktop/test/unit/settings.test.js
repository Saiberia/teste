'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_SETTINGS, validateAccelerator, isValidAccelerator, normalizeSettings, settingsFromResponse } = require('../../src/settings');
const { t, STRINGS, normalizeLang } = require('../../src/i18n');
const { DesktopState, visibleBounds, defaultPanelBounds } = require('../../src/state');

test('valid global accelerators', () => {
  for (const a of ['CommandOrControl+Shift+R', 'CmdOrCtrl+Alt+R', 'Ctrl+Shift+Space', 'Alt+F2', 'F9',
    'Super+Shift+1', 'Option+Command+P', 'Shift+Plus', 'Control+/', 'MediaPlayPause', 'ctrl+shift+r']) {
    assert.ok(isValidAccelerator(a), a);
  }
});

test('invalid accelerators are rejected with a reason', () => {
  const cases = {
    '': /пуст/,
    '   ': /пуст/,
    R: /модификатор/,
    'Shift+': /Plus/,
    'Ctrl++': /Plus/,
    'Ctrl+Shift': /одна основная/,
    'Ctrl+A+B': /одна основная/,
    'Ctrl+Ctrl+A': /повторяется/,
    'Hyper+A': /неизвестная/,
    'Ctrl+Ё': /неизвестная/,
    'Invalid+++': /Plus/,
  };
  for (const [a, re] of Object.entries(cases)) {
    const r = validateAccelerator(a);
    assert.equal(r.ok, false, a);
    assert.match(r.error, re, a);
  }
  assert.equal(validateAccelerator(null).ok, false);
  assert.equal(validateAccelerator(`Ctrl+${'A'.repeat(80)}`).ok, false);
});

test('normalizeSettings keeps valid values, falls back on junk, keeps unknown keys', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  const s = normalizeSettings({
    ui_language: 'en', theme: 'dark', capture_chunk_seconds: '8', capture_sources: ['system', 'bogus', 'system'],
    capture_silence_threshold: 0.01, panel_hotkey: ' Alt+F2 ', panel_always_on_top: 'false',
    panel_hide_from_screen_share: false, llm_provider: 'claude',
  });
  assert.equal(s.ui_language, 'en');
  assert.equal(s.theme, 'dark');
  assert.equal(s.capture_chunk_seconds, 8);
  assert.deepEqual(s.capture_sources, ['system']);
  assert.equal(s.capture_silence_threshold, 0.01);
  assert.equal(s.panel_hotkey, 'Alt+F2');
  assert.equal(s.panel_always_on_top, false);
  assert.equal(s.panel_hide_from_screen_share, false);
  assert.equal(s.llm_provider, 'claude');

  const bad = normalizeSettings({ ui_language: 'de', theme: 'neon', capture_chunk_seconds: 0, capture_sources: [],
    capture_silence_threshold: -1, panel_hotkey: '', panel_always_on_top: 'maybe' });
  for (const k of ['ui_language', 'theme', 'capture_chunk_seconds', 'capture_sources', 'capture_silence_threshold', 'panel_hotkey', 'panel_always_on_top']) {
    assert.deepEqual(bad[k], DEFAULT_SETTINGS[k], k);
  }
});

test('normalizeSettings merges a partial update over the current settings', () => {
  const current = normalizeSettings({ ui_language: 'en', panel_always_on_top: false });
  const next = normalizeSettings({ panel_hotkey: 'F8' }, current);
  assert.equal(next.ui_language, 'en');
  assert.equal(next.panel_always_on_top, false);
  assert.equal(next.panel_hotkey, 'F8');
});

test('settingsFromResponse extracts values', () => {
  assert.deepEqual(settingsFromResponse({ values: { a: 1 }, schema: [] }), { a: 1 });
  assert.equal(settingsFromResponse({ detail: 'x' }), null);
  assert.equal(settingsFromResponse(null), null);
});

test('i18n: ru and en have the same keys; fallback to ru; placeholders', () => {
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.ru).sort());
  assert.equal(t('ru', 'menuShowPanel'), 'Показать панель');
  assert.equal(t('en', 'menuShowPanel'), 'Show panel');
  assert.equal(t('de', 'menuShowPanel'), 'Показать панель');
  assert.equal(normalizeLang('__proto__'), 'ru');
  assert.equal(t('en', 'hotkeyBusy', { accel: 'F9' }), 'The shortcut F9 is already used by another application');
  assert.equal(t('ru', 'noSuchKey'), 'noSuchKey');
});

test('panel bounds: saved position is used only when visible', () => {
  const areas = [{ x: 0, y: 25, width: 1440, height: 875 }];
  const b = { x: 1000, y: 100, width: 380, height: 560 };
  assert.deepEqual(visibleBounds(b, areas), b);
  assert.equal(visibleBounds({ ...b, x: 5000 }, areas), null, 'monitor unplugged');
  assert.equal(visibleBounds({ ...b, width: 10 }, areas), null);
  assert.equal(visibleBounds({ x: 'a' }, areas), null);
  assert.equal(visibleBounds(undefined, areas), null);
  assert.deepEqual(defaultPanelBounds(areas[0]), { x: 1440 - 380 - 16, y: 25 + 16, width: 380, height: 560 });
});

test('DesktopState persists JSON and survives corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recapper-state-'));
  const file = path.join(dir, 'state.json');
  const s = new DesktopState(file);
  assert.equal(s.get('lastLanguage', 'ru'), 'ru');
  s.set('lastLanguage', 'en');
  s.flush();
  assert.equal(new DesktopState(file).get('lastLanguage'), 'en');
  fs.writeFileSync(file, '{broken');
  assert.equal(new DesktopState(file).get('lastLanguage', 'ru'), 'ru');
  fs.rmSync(dir, { recursive: true, force: true });
});
