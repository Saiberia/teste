'use strict';
// Optional end-to-end run against the REAL backend (`python -m recapper serve`)
// with the simulated AI provider (RECAPPER_LLM=sim-good). Skipped when the
// backend or its dependencies are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  REPO_ROOT, PYTHON, guiSkipReason, tmpDir, launchApp, waitFor, windowPages, authed, waitDead, closeApp, requestJson,
} = require('./helpers');

function backendSkipReason() {
  const r = spawnSync(PYTHON, ['-m', 'recapper', 'serve', '--help'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  if (r.error) return `python not available: ${r.error.message}`;
  if (r.status !== 0 || !/--token/.test(r.stdout)) return `\`${PYTHON} -m recapper serve --help\` failed (backend not installed?)`;
  return null;
}

const skip = guiSkipReason() || backendSkipReason() || false;

test('real backend: dev launch, UI + capture.js, settings, audio contract, clean quit', { skip, timeout: 180_000 }, async () => {
  const dataDir = tmpDir('recapper-real-data-');
  const env = {
    RECAPPER_BACKEND_CMD: '', // use the real dev command: <python> -m recapper serve ...
    RECAPPER_PYTHON: PYTHON,
    RECAPPER_LLM: 'sim-good',
    RECAPPER_ASR: 'none', // deterministic: the audio endpoint must answer 503
    RECAPPER_DATA_DIR: dataDir,
    RECAPPER_TEST_FAKE_MEDIA: '1',
  };
  const { app, userDataDir, output } = await launchApp({ env });
  let backendPid = null;
  let token = null;
  try {
    const { main, panel, origin } = await windowPages(app);
    token = await app.evaluate(() => global.__recapper.backend.token);
    assert.match(token, /^[0-9a-f]{48}$/);
    // The UI moves the token from the URL into sessionStorage.
    await waitFor(async () => (await main.evaluate(() => sessionStorage.getItem('recapper_token'))) === token, { message: 'token in sessionStorage' });
    assert.ok(!main.url().includes(token), 'token removed from the address bar');

    const desk = await app.evaluate(() => {
      const c = global.__recapper;
      return { pid: c.backend.pid, readyVia: c.backend.readyVia, hotkey: c.hotkey, settings: c.settings };
    });
    backendPid = desk.pid;
    assert.ok(['ready-line', 'health'].includes(desk.readyVia), desk.readyVia);

    const health = await requestJson(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(health.json.auth, true);
    assert.equal((await requestJson(`${origin}/api/settings`)).status, 401, 'token required');
    const settings = await requestJson(`${origin}/api/settings`, authed(token));
    assert.equal(settings.status, 200);
    const values = settings.json.values;
    assert.ok(values && typeof values === 'object');
    if (values.panel_hotkey) assert.equal(desk.hotkey, values.panel_hotkey, 'desktop registered the hotkey from /api/settings');
    if (values.ui_language) assert.equal(desk.settings.ui_language, values.ui_language);

    // The real UI loads capture.js and sees the desktop bridge (both windows).
    await waitFor(() => main.evaluate(() => typeof window.RecapperCapture === 'object'), { message: 'capture.js in main UI' });
    assert.equal(await main.evaluate(() => window.RecapperCapture.isDesktop), true);
    await waitFor(() => panel.evaluate(() => typeof window.RecapperCapture === 'object' && window.recapperDesktop.view === 'panel'), { message: 'panel UI' });
    const applied = await main.evaluate(async (tok) => {
      const r = await fetch('/api/settings', { headers: { Authorization: `Bearer ${tok}` } });
      return window.recapperDesktop.applySettings((await r.json()).values);
    }, token);
    assert.equal(applied.ok, true, JSON.stringify(applied));

    // Live session + microphone capture against the real /audio endpoint.
    const live = await requestJson(`${origin}/api/live`, {
      method: 'POST', ...authed(token), body: { title: 'E2E real', auto_answer: 'commands' },
    });
    assert.equal(live.status, 200, live.text);
    const sid = live.json.id;
    assert.ok(sid);
    const open = await requestJson(`${origin}/api/live`, authed(token));
    assert.ok(Array.isArray(open.json) && open.json.some((s) => s.id === sid), 'GET /api/live lists the session');

    const outcome = await main.evaluate(async ({ sid: id, tok }) => {
      const errors = [];
      const results = [];
      const info = await window.RecapperCapture.start({
        sessionId: id, token: tok, sources: ['mic'], chunkSeconds: 2, silenceThreshold: 0.004,
        onError: (e) => errors.push({ status: e.status, code: e.code, fatal: e.fatal, message: e.message }),
        onResult: (body) => results.push(body),
      });
      const until = Date.now() + 30000;
      while (!errors.length && !results.length && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      await new Promise((r) => setTimeout(r, 300));
      const running = window.RecapperCapture.running;
      await window.RecapperCapture.stop();
      return { info, errors, results, running };
    }, { sid, tok: token });
    assert.deepEqual(outcome.info.sources, ['mic']);
    // ASR is off: the backend answers 503, capture reports it once and stops itself.
    assert.equal(outcome.errors.length, 1, JSON.stringify(outcome));
    assert.equal(outcome.errors[0].status, 503);
    assert.equal(outcome.errors[0].code, 'asr_unavailable');
    assert.equal(outcome.errors[0].fatal, true);
    assert.equal(outcome.running, false, 'capture stopped after a fatal error');

    // Session is still usable over the text API; events are readable with the token.
    const events = await requestJson(`${origin}/api/live/${sid}/events?since=0`, authed(token));
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.json.events));
    const fin = await requestJson(`${origin}/api/live/${sid}/finish`, { method: 'POST', ...authed(token), timeoutMs: 30_000 });
    assert.ok(fin.status === 200 || fin.status === 202, `finish -> ${fin.status} ${fin.text.slice(0, 200)}`);
  } catch (err) {
    err.message += `\n--- electron output ---\n${output.join('').slice(-4000)}`;
    throw err;
  } finally {
    await closeApp(app);
  }
  assert.ok(backendPid);
  assert.ok(await waitDead(backendPid), `real backend ${backendPid} still running after quit`);
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'backend.log'), 'utf8');
  assert.match(log, /RECAPPER_READY/);
  assert.ok(!log.includes(token), 'token never written to the log');
  assert.ok(fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0, 'backend used RECAPPER_DATA_DIR');
});
