'use strict';
// Shared helpers for the Playwright `_electron` end-to-end tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const { requestJson } = require('../../src/net');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');
const FAKE_BACKEND = path.join(APP_DIR, 'test', 'fixtures', 'fake_backend.py');
const PYTHON = process.env.RECAPPER_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

/** Unpacked packaged build in desktop/dist (or $RECAPPER_PACKAGED_APP), or null. */
function findPackagedApp() {
  if (process.env.RECAPPER_PACKAGED_APP) return path.resolve(process.env.RECAPPER_PACKAGED_APP);
  const dist = path.join(APP_DIR, 'dist');
  const candidates = [];
  if (process.platform === 'linux') candidates.push(path.join(dist, 'linux-unpacked', 'recapper-desktop'));
  if (process.platform === 'win32') candidates.push(path.join(dist, 'win-unpacked', 'Recapper.exe'));
  if (process.platform === 'darwin') {
    for (const d of ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']) {
      candidates.push(path.join(dist, d, 'Recapper.app', 'Contents', 'MacOS', 'Recapper'));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/** Reason to skip GUI tests, or null. */
function guiSkipReason() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return 'no display: run under `xvfb-run -a npm run test:e2e`';
  }
  return null;
}

function tmpDir(prefix = 'recapper-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Launches the app. Dev mode by default (electron binary + desktop/ dir);
 * pass `executablePath` to launch a packaged build instead.
 */
async function launchApp({ env = {}, userDataDir = tmpDir(), executablePath = null } = {}) {
  const args = [];
  // Chromium refuses to run as root with its sandbox (CI containers).
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  if (!executablePath) args.push(APP_DIR);
  const app = await _electron.launch({
    executablePath: executablePath || require('electron'),
    args,
    cwd: APP_DIR,
    env: {
      ...process.env,
      RECAPPER_TEST_FAKE_MEDIA: '1',
      RECAPPER_USER_DATA: userDataDir,
      RECAPPER_QUIET: '1',
      ...env,
    },
    timeout: 60_000,
  });
  const output = [];
  const proc = app.process();
  proc.stdout.on('data', (d) => output.push(String(d)));
  proc.stderr.on('data', (d) => output.push(String(d)));
  return { app, userDataDir, output, pid: proc.pid };
}

async function waitFor(fn, { timeout = 30_000, interval = 100, message = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${message} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

/** Page whose URL matches `pred` (main window: token without view=panel). */
function waitForPage(app, pred, message) {
  return waitFor(() => app.windows().find((p) => {
    try {
      return pred(p.url());
    } catch {
      return false;
    }
  }), { message });
}

/**
 * {main, panel} pages identified through their BrowserWindow (the real UI
 * strips ?token= from the address bar, so URLs are not reliable).
 */
async function windowPages(app, { timeout = 60_000 } = {}) {
  return waitFor(async () => {
    const ids = await app.evaluate(() => {
      const c = global.__recapper;
      const id = (w) => (w && !w.isDestroyed() ? w.id : null);
      return { main: id(c.mainWindow), panel: id(c.panelWindow), origin: c.backendOrigin };
    });
    if (!ids.main || !ids.panel || !ids.origin) return null;
    const out = {};
    for (const page of app.windows()) {
      if (!page.url().startsWith(ids.origin)) continue;
      const bw = await app.browserWindow(page);
      const id = await bw.evaluate((w) => w.id);
      if (id === ids.main) out.main = page;
      if (id === ids.panel) out.panel = page;
    }
    return out.main && out.panel ? { ...out, origin: ids.origin } : null;
  }, { timeout, message: 'main and panel windows on the backend origin' });
}

const isMainUrl = (u) => /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/.test(u);
const isPanelUrl = (u) => /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}&view=panel$/.test(u);

function authed(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

async function closeApp(app) {
  try {
    await app.close();
  } catch {
    /* already closed */
  }
}

module.exports = {
  APP_DIR, REPO_ROOT, FAKE_BACKEND, PYTHON, guiSkipReason, findPackagedApp, tmpDir, launchApp, waitFor, waitForPage, windowPages,
  isMainUrl, isPanelUrl, authed, isAlive, waitDead, closeApp, requestJson,
};
