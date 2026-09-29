'use strict';
// End-to-end: the real Electron app (Playwright `_electron`) + the fake backend
// (test/fixtures/fake_backend.py) + Chromium's fake microphone/screen devices.
// Linux: run under `xvfb-run -a npm run test:e2e`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FAKE_BACKEND, PYTHON, guiSkipReason, tmpDir, launchApp, waitFor, waitForPage, isMainUrl, isPanelUrl,
  authed, waitDead, closeApp, requestJson,
} = require('./helpers');

const skip = guiSkipReason() || false;
const FAKE_CMD = JSON.stringify([PYTHON, FAKE_BACKEND]);

function checkWav(c) {
  assert.equal(c.riff, true, 'RIFF/WAVE');
  assert.equal(c.fmt_tag, 1, 'PCM');
  assert.equal(c.channels, 1, 'mono');
  assert.equal(c.sample_rate, 16000, '16 kHz');
  assert.equal(c.bits, 16, '16-bit');
  assert.equal(c.byte_rate, 32000);
  assert.equal(c.block_align, 2);
  assert.equal(c.data_tag, 'data');
  assert.equal(c.data_len, c.bytes - 44, 'data size matches');
  assert.equal(c.riff_size, c.bytes - 8, 'RIFF size matches');
  assert.ok(c.duration > 0.3 && c.duration <= 2.01, `duration ${c.duration}`);
  assert.ok(c.rms > 0.001, `not silent (rms ${c.rms})`);
}

async function chunks(origin, token) {
  const r = await requestJson(`${origin}/__test__/chunks`, authed(token));
  assert.equal(r.status, 200);
  return r.json.chunks;
}

test('desktop app: backend, windows, panel, settings, security, capture, quit', { skip }, async () => {
  // 'ui': Chromium answers getDisplayMedia with fake screen + fake audio, so both
  // sources carry sound (the loopback handler itself is covered by the next test).
  const { app, userDataDir, output, pid: electronPid } = await launchApp({
    env: { RECAPPER_BACKEND_CMD: FAKE_CMD, RECAPPER_TEST_FAKE_MEDIA: 'ui' },
  });
  let backendPid = null;
  let token = null;
  try {
    // ---- backend spawned with a random token; both windows load the backend UI
    const main = await waitForPage(app, isMainUrl, 'main window');
    const panel = await waitForPage(app, isPanelUrl, 'panel window');
    const url = new URL(main.url());
    token = url.searchParams.get('token');
    const origin = url.origin;
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.equal(url.hostname, '127.0.0.1');

    const info = await requestJson(`${origin}/__test__/info`, authed(token));
    assert.equal(info.status, 200, 'backend accepts the token the app generated');
    backendPid = info.json.pid;
    assert.equal(info.json.ppid, electronPid, 'spawned by the Electron main process');
    const i = info.json.argv.indexOf('--token');
    assert.equal(info.json.argv[0], 'serve');
    assert.equal(info.json.argv[i + 1], token);
    assert.equal(info.json.argv[info.json.argv.indexOf('--host') + 1], '127.0.0.1');
    assert.equal((await requestJson(`${origin}/__test__/info`)).status, 401, 'API requires the token');

    await main.waitForSelector('#view');
    assert.equal(await main.textContent('#view'), 'main');
    assert.equal(await panel.textContent('#view'), 'panel');
    const bridge = await main.evaluate(() => ({
      platform: window.recapperDesktop.platform,
      version: window.recapperDesktop.version,
      view: window.recapperDesktop.view,
      isDesktop: window.RecapperCapture.isDesktop,
      node: typeof window.require,
      token: sessionStorage.getItem('recapper_token'),
    }));
    assert.equal(bridge.platform, process.platform);
    assert.equal(bridge.version, require('../../package.json').version);
    assert.equal(bridge.view, 'main');
    assert.equal(bridge.isDesktop, true);
    assert.equal(bridge.node, 'undefined', 'no Node integration in the renderer');
    assert.equal(bridge.token, token);
    assert.equal(await panel.evaluate(() => window.recapperDesktop.view), 'panel');

    // ---- window configuration (main process)
    const wins = await app.evaluate(({ globalShortcut, Menu }) => {
      const c = global.__recapper;
      const m = c.mainWindow;
      const p = c.panelWindow;
      const prefs = (w) => {
        const wp = w.webContents.getLastWebPreferences();
        return { contextIsolation: wp.contextIsolation, nodeIntegration: wp.nodeIntegration, sandbox: wp.sandbox };
      };
      const labels = [];
      const walk = (menu) => menu.items.forEach((it) => { labels.push(it.label); if (it.submenu) walk(it.submenu); });
      walk(Menu.getApplicationMenu());
      return {
        mainSize: m.getSize(), panelSize: p.getSize(), panelOnTop: p.isAlwaysOnTop(),
        panelProtected: p.isContentProtected(), recordedProtection: c.panelContentProtection,
        panelVisible: p.isVisible(), mainVisible: m.isVisible(), hotkey: c.hotkey,
        registered: globalShortcut.isRegistered(c.hotkey), mainPrefs: prefs(m), panelPrefs: prefs(p),
        labels, tray: Boolean(c.tray), backendReadyVia: c.backend.readyVia,
      };
    });
    assert.deepEqual(wins.mainSize, [1100, 800]);
    assert.deepEqual(wins.panelSize, [380, 560]);
    assert.equal(wins.panelOnTop, true, 'panel is always on top');
    if (process.platform === 'linux') {
      // Electron implements content protection on macOS/Windows only.
      assert.equal(wins.recordedProtection, true, 'setContentProtection(true) applied');
    } else {
      assert.equal(wins.panelProtected, true, 'panel excluded from screen capture');
    }
    assert.equal(wins.mainVisible, true);
    assert.equal(wins.panelVisible, false, 'panel starts hidden');
    assert.equal(wins.hotkey, 'CommandOrControl+Shift+R', 'hotkey from /api/settings');
    assert.equal(wins.registered, true);
    for (const p of [wins.mainPrefs, wins.panelPrefs]) assert.deepEqual(p, { contextIsolation: true, nodeIntegration: false, sandbox: true });
    assert.ok(wins.labels.includes('Показать панель'), wins.labels.join('|'));
    assert.equal(wins.backendReadyVia, 'ready-line');

    // ---- panel toggle through the preload bridge
    assert.equal(await main.evaluate(() => window.recapperDesktop.togglePanel()), true);
    await waitFor(() => app.evaluate(() => global.__recapper.panelWindow.isVisible()), { message: 'panel shown' });
    assert.equal(await app.evaluate(() => global.__recapper.panelWindow.isAlwaysOnTop()), true);
    assert.equal(await main.evaluate(() => window.recapperDesktop.togglePanel()), false);
    await waitFor(async () => !(await app.evaluate(() => global.__recapper.panelWindow.isVisible())), { message: 'panel hidden' });

    // ---- applySettings: invalid hotkey keeps the old one; valid settings apply live
    await app.evaluate(() => {
      const p = global.__recapper.panelWindow;
      global.__cp = [];
      const orig = p.setContentProtection.bind(p);
      p.setContentProtection = (v) => { global.__cp.push(v); return orig(v); };
    });
    const bad = await main.evaluate(() => window.recapperDesktop.applySettings({ panel_hotkey: 'Invalid+++' }));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Plus|сочетание/);
    assert.equal(bad.hotkey, 'CommandOrControl+Shift+R');
    assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R')), true);

    const good = await main.evaluate(() => window.recapperDesktop.applySettings({
      panel_hotkey: 'CommandOrControl+Alt+K', panel_hide_from_screen_share: false, panel_always_on_top: false,
      ui_language: 'en', theme: 'dark',
    }));
    assert.deepEqual(good, { ok: true, hotkey: 'CommandOrControl+Alt+K' });
    const after = await app.evaluate(({ globalShortcut, Menu, nativeTheme }) => ({
      newKey: globalShortcut.isRegistered('CommandOrControl+Alt+K'),
      oldKey: globalShortcut.isRegistered('CommandOrControl+Shift+R'),
      onTop: global.__recapper.panelWindow.isAlwaysOnTop(),
      cp: global.__cp.slice(),
      menu: Menu.getApplicationMenu().items.map((i) => i.label),
      title: global.__recapper.panelWindow.getTitle(),
      theme: nativeTheme.themeSource,
    }));
    assert.equal(after.newKey, true);
    assert.equal(after.oldKey, false, 'old hotkey released');
    assert.equal(after.onTop, false);
    assert.equal(after.cp.at(-1), false, 'content protection switched off by the setting');
    assert.ok(after.menu.includes('View') && after.menu.includes('Help'), after.menu.join('|'));
    assert.equal(after.title, 'Recapper — panel');
    assert.equal(after.theme, 'dark');
    const restored = await main.evaluate(() => window.recapperDesktop.applySettings({
      panel_hotkey: 'CommandOrControl+Shift+R', panel_hide_from_screen_share: true, panel_always_on_top: true,
      ui_language: 'ru', theme: 'system',
    }));
    assert.equal(restored.ok, true);
    const back = await app.evaluate(() => ({ onTop: global.__recapper.panelWindow.isAlwaysOnTop(), cp: global.__cp.at(-1) }));
    assert.deepEqual(back, { onTop: true, cp: true });
    await waitFor(() => {
      const st = JSON.parse(fs.readFileSync(path.join(userDataDir, 'desktop-state.json'), 'utf8'));
      return st.lastLanguage === 'ru';
    }, { message: 'desktop-state.json persisted' });

    // ---- capture: 2 s chunks via /api/settings, real click (user activation)
    const put = await requestJson(`${origin}/api/settings`, { method: 'PUT', ...authed(token), body: { values: { capture_chunk_seconds: 2 } } });
    assert.equal(put.status, 200);
    await main.click('#start');
    const started = await waitFor(() => main.evaluate(() => window.__test.startInfo || (window.__test.startError && { error: window.__test.startError })), { message: 'capture start' });
    assert.ok(!started.error, started.error);
    assert.deepEqual(started.sources.slice().sort(), ['mic', 'system'], 'fake devices provide mic + system audio');
    assert.equal(started.config.chunkSeconds, 2, 'chunk length from /api/settings');
    assert.equal(started.sampleRates.mic, 16000);
    assert.equal(await main.evaluate(() => window.RecapperCapture.running), true);
    await waitFor(() => app.evaluate(() => global.__recapper.capturing), { message: 'main process knows we are recording' });

    const got = await waitFor(async () => {
      const list = await chunks(origin, token);
      const mic = list.filter((c) => c.source === 'mic');
      const sys = list.filter((c) => c.source === 'system');
      return mic.length >= 2 && sys.length >= 2 ? list : null;
    }, { timeout: 30_000, message: 'mic and system chunks' });
    for (const c of got) checkWav(c);
    for (const src of ['mic', 'system']) {
      const offs = got.filter((c) => c.source === src).map((c) => c.offset);
      for (let k = 1; k < offs.length; k++) assert.ok(offs[k] > offs[k - 1], `${src} offsets increase: ${offs}`);
      assert.ok(offs[0] >= 0 && offs[0] < 3, `${src} first offset ${offs[0]}`);
    }
    const results = await main.evaluate(() => window.__test.results.length);
    assert.ok(results >= 4, 'onResult called per upload');

    const before = (await chunks(origin, token)).length;
    await main.evaluate(() => window.RecapperCapture.stop());
    const afterStop = await chunks(origin, token);
    assert.ok(afterStop.length >= before, 'stop() uploads the tail');
    assert.equal(await main.evaluate(() => window.RecapperCapture.running), false);
    await waitFor(async () => !(await app.evaluate(() => global.__recapper.capturing)), { message: 'capturing flag cleared' });
    const errors = await main.evaluate(() => window.__test.errors);
    assert.deepEqual(errors, []);
    const stats = await main.evaluate(() => window.RecapperCapture.stats());
    assert.equal(stats.mic.sent + stats.system.sent, afterStop.length);

    // ---- security (last: Playwright waits on the cancelled navigation): external links go to the OS browser, everything else is blocked
    await app.evaluate(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (u) => { global.__opened.push(u); };
    });
    await main.evaluate(() => {
      window.open('https://example.com/docs', '_blank');
      window.open('file:///etc/passwd');
      window.open('javascript:alert(1)');
    });
    await main.evaluate(() => { location.href = 'https://example.org/'; });
    await waitFor(() => app.evaluate(() => global.__opened.length >= 2), { message: 'openExternal calls' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await app.evaluate(() => global.__opened), ['https://example.com/docs', 'https://example.org/']);
    assert.ok(isMainUrl(main.url()), `main window stayed on the backend: ${main.url()}`);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2, 'no new windows');


  } catch (err) {
    err.message += `\n--- electron output ---\n${output.join('').slice(-4000)}`;
    throw err;
  } finally {
    await closeApp(app);
  }
  // ---- quitting the app kills the backend
  assert.ok(backendPid, 'saw backend pid');
  assert.ok(await waitDead(backendPid), `backend ${backendPid} still running after quit`);
  const backendLog = fs.readFileSync(path.join(userDataDir, 'logs', 'backend.log'), 'utf8');
  assert.match(backendLog, /POST \/api\/live\/sid1\/audio/);
  assert.ok(!backendLog.includes(token), 'token never written to logs');
  assert.ok(!fs.readFileSync(path.join(userDataDir, 'logs', 'desktop.log'), 'utf8').includes(token));
});

test('system audio unavailable: capture degrades to microphone only', { skip }, async () => {
  // Fake microphone only: getDisplayMedia goes through electron-audio-loopback.
  const { app, output, userDataDir } = await launchApp({ env: { RECAPPER_BACKEND_CMD: FAKE_CMD, RECAPPER_TEST_FAKE_MEDIA: '1' } });
  try {
    const main = await waitForPage(app, isMainUrl, 'main window');
    const url = new URL(main.url());
    const token = url.searchParams.get('token');
    await main.waitForSelector('#start');
    // Permission policy (fake-UI mode would bypass it, so it is checked here).
    const camera = await main.evaluate(async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        return 'granted';
      } catch (e) {
        return e.name;
      }
    });
    assert.equal(camera, 'NotAllowedError', 'camera is never granted');
    const geo = await main.evaluate(() => new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      () => resolve('granted'), (e) => resolve(e.code === 1 ? 'denied' : `error ${e.code}`), { timeout: 3000 })));
    assert.equal(geo, 'denied', 'geolocation denied');
    const startAgain = async (label) => {
      await main.evaluate(() => { window.__test.startInfo = null; window.__test.startError = null; window.__test.statuses = []; });
      await main.click('#start');
      return waitFor(() => main.evaluate(() => window.__test.startInfo || (window.__test.startError && { error: window.__test.startError })), { message: label });
    };

    // (0) The real loopback library path. In a container there is no audio
    // server, so the "System audio" track delivers only silence: the user gets
    // a warning, silent chunks are not uploaded, the microphone keeps working.
    await main.evaluate(() => { window.__captureOptions = { chunkSeconds: 2, silenceWarnMs: 3000 }; });
    const s0 = await startAgain('start #0');
    assert.ok(!s0.error, s0.error);
    assert.deepEqual(s0.sources.slice().sort(), ['mic', 'system']);
    const sid0 = await main.evaluate(() => window.__test.sid);
    await waitFor(async () => (await chunks(url.origin, token)).filter((c) => c.session === sid0 && c.source === 'mic').length >= 2, { message: 'mic chunks #0' });
    await new Promise((r) => setTimeout(r, 3500));
    const st0 = await main.evaluate(() => window.RecapperCapture.stats());
    const statuses0 = await main.evaluate(() => window.__test.statuses);
    await main.evaluate(() => window.RecapperCapture.stop());
    const list0 = (await chunks(url.origin, token)).filter((c) => c.session === sid0);
    for (const c of list0) checkWav(c);
    assert.equal(st0.mic.heard, true);
    if (!st0.system.heard) {
      assert.ok(statuses0.some((s) => s.code === 'system_silent' && s.level === 'warning' && /Запись с микрофона продолжается/.test(s.msg)),
        JSON.stringify(statuses0));
      assert.equal(list0.filter((c) => c.source === 'system').length, 0, 'silent system audio is not uploaded');
    } else {
      assert.ok(list0.some((c) => c.source === 'system'), 'audible system audio is uploaded');
    }
    const desktopLog = fs.readFileSync(path.join(userDataDir, 'logs', 'desktop.log'), 'utf8');
    assert.match(desktopLog, /loopback: [1-9]\d* screen source/, 'electron-audio-loopback handler answered getDisplayMedia');
    assert.doesNotMatch(desktopLog, /permission denied: media for \S+ \["audio"\]/, 'microphone was granted by our handler');
    assert.match(desktopLog, /permission denied: (media|geolocation)/, 'camera/geolocation went through the deny path');

    // (1) Loopback that never answers — what electron-audio-loopback does when
    // macOS has no Screen Recording permission (no sources): capture times out.
    await app.evaluate(({ ipcMain, session }) => {
      ipcMain.removeHandler('enable-loopback-audio');
      ipcMain.handle('enable-loopback-audio', () => {
        session.defaultSession.setDisplayMediaRequestHandler(() => { /* never calls back */ });
      });
    });
    await main.evaluate(() => { window.__captureOptions = { chunkSeconds: 2, systemTimeoutMs: 1500 }; });
    const s1 = await startAgain('start #1');
    assert.ok(!s1.error, s1.error);
    assert.deepEqual(s1.sources, ['mic']);
    assert.equal(s1.warnings[0].code, 'system_unavailable');
    assert.match(s1.warnings[0].message, /Продолжаю только с микрофоном/);
    const statuses = await main.evaluate(() => window.__test.statuses);
    assert.ok(statuses.some((s) => s.code === 'system_unavailable' && s.level === 'warning' && typeof s.msg === 'string'));
    const sid1 = await main.evaluate(() => window.__test.sid);
    await waitFor(async () => (await chunks(url.origin, token)).some((c) => c.session === sid1), { message: 'mic chunk #1' });
    await main.evaluate(() => window.RecapperCapture.stop());

    // (2) Loopback that yields a stream without audio (no system audio device).
    await app.evaluate(({ ipcMain, session, desktopCapturer }) => {
      ipcMain.removeHandler('enable-loopback-audio');
      ipcMain.handle('enable-loopback-audio', () => {
        session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          cb({ video: sources[0] });
        });
      });
    });
    const s2 = await startAgain('start #2');
    assert.ok(!s2.error, s2.error);
    assert.deepEqual(s2.sources, ['mic']);
    assert.match(s2.warnings[0].message, /Системный звук недоступен/);
    const sid2 = await main.evaluate(() => window.__test.sid);
    const list = await waitFor(async () => {
      const all = (await chunks(url.origin, token)).filter((c) => c.session === sid1 || c.session === sid2);
      return all.some((c) => c.session === sid2) ? all : null;
    }, { message: 'mic chunk #2' });
    await main.evaluate(() => window.RecapperCapture.stop());
    assert.ok(list.every((c) => c.source === 'mic'), 'only microphone chunks');
    for (const c of list) checkWav(c);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.webContents.isCrashed())), true);
  } catch (err) {
    err.message += `\n--- electron output ---\n${output.join('').slice(-4000)}`;
    throw err;
  } finally {
    await closeApp(app);
  }
});

test('backend start failure shows the error page; "retry" recovers', { skip }, async () => {
  const marker = path.join(tmpDir(), 'failed-once');
  const { app, output } = await launchApp({ env: { RECAPPER_BACKEND_CMD: FAKE_CMD, FAKE_FAIL_ONCE_FILE: marker } });
  try {
    const errPage = await waitForPage(app, (u) => u.startsWith('file:') && u.includes('error.html'), 'error page');
    await errPage.waitForSelector('#retry');
    assert.match(await errPage.textContent('#title'), /Recapper/);
    assert.match(await errPage.textContent('#message'), /завершился при запуске/);
    assert.match(await errPage.textContent('#details'), /simulated first-start failure/);
    assert.match(await errPage.textContent('#logLine'), /backend\.log/);
    await errPage.click('#retry');
    const main = await waitForPage(app, isMainUrl, 'main window after retry');
    await main.waitForSelector('#view');
    assert.equal(await main.textContent('#view'), 'main');
    await waitForPage(app, isPanelUrl, 'panel after retry');
  } catch (err) {
    err.message += `\n--- electron output ---\n${output.join('').slice(-4000)}`;
    throw err;
  } finally {
    await closeApp(app);
  }
});
