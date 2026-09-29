'use strict';
// Smoke test of a PACKAGED build (electron-builder --dir output) with the bundled
// PyInstaller backend in <resources>/backend. Skipped when no packaged build exists.
//   Linux:   npm run dist:dir            -> dist/linux-unpacked/recapper-desktop
//   Windows: npx electron-builder --win dir -> dist/win-unpacked/Recapper.exe
//   macOS:   npx electron-builder --mac dir -> dist/mac-arm64/Recapper.app
// Or point RECAPPER_PACKAGED_APP at the executable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  guiSkipReason, findPackagedApp, tmpDir, launchApp, waitFor, windowPages, authed, waitDead, closeApp, requestJson,
} = require('./helpers');

const exe = findPackagedApp();
const skip = guiSkipReason() || (exe ? false : 'no packaged build (run `npm run dist:dir` after building the backend)');

test('packaged app: bundled backend starts from resources, UI loads, audio endpoint works, quit kills it', { skip, timeout: 240_000 }, async () => {
  const dataDir = tmpDir('recapper-packaged-data-');
  const { app, userDataDir, output } = await launchApp({
    executablePath: exe,
    env: {
      RECAPPER_BACKEND_CMD: '',
      RECAPPER_LLM: 'sim-good',
      RECAPPER_ASR: 'none',
      RECAPPER_DATA_DIR: dataDir,
      RECAPPER_TEST_FAKE_MEDIA: '1',
      RECAPPER_BACKEND_TIMEOUT_MS: '120000',
    },
  });
  let backendPid = null;
  try {
    const { main, origin } = await windowPages(app, { timeout: 150_000 });
    const desk = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged,
      resources: process.resourcesPath,
      pid: global.__recapper.backend.pid,
      token: global.__recapper.backend.token,
    }));
    backendPid = desk.pid;
    assert.equal(desk.packaged, true);
    const log = fs.readFileSync(path.join(userDataDir, 'logs', 'backend.log'), 'utf8');
    const binary = path.join(desk.resources, 'backend', process.platform === 'win32' ? 'recapper-server.exe' : 'recapper-server');
    assert.ok(log.includes(`starting backend (packaged): ${binary}`), log.slice(0, 2000));

    const health = await requestJson(`${origin}/api/health`);
    assert.equal(health.json.status, 'ok');
    const js = await requestJson(`${origin}/static/capture.js`);
    assert.equal(js.status, 200);
    assert.match(js.text, /RecapperCapture/);
    await waitFor(() => main.evaluate(() => typeof window.RecapperCapture === 'object' && window.RecapperCapture.isDesktop), { message: 'capture.js in the UI' });

    // Multipart upload through the frozen backend (ASR off -> 503 after the form is parsed).
    const live = await requestJson(`${origin}/api/live`, { method: 'POST', ...authed(desk.token), body: { title: 'packaged' } });
    assert.equal(live.status, 200, live.text);
    const outcome = await main.evaluate(async ({ sid, tok }) => {
      const errors = [];
      await window.RecapperCapture.start({
        sessionId: sid, token: tok, sources: ['mic'], chunkSeconds: 2, silenceThreshold: 0.004,
        onError: (e) => errors.push({ status: e.status, code: e.code }),
      });
      const until = Date.now() + 30000;
      while (!errors.length && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      await window.RecapperCapture.stop();
      return errors;
    }, { sid: live.json.id, tok: desk.token });
    assert.deepEqual(outcome, [{ status: 503, code: 'asr_unavailable' }]);
  } catch (err) {
    err.message += `\n--- electron output ---\n${output.join('').slice(-4000)}`;
    throw err;
  } finally {
    await closeApp(app);
  }
  assert.ok(backendPid);
  assert.ok(await waitDead(backendPid), 'bundled backend stopped with the app');
});
