'use strict';
// Recapper desktop shell: starts the local Python backend, shows its web UI in
// the main window and a compact always-on-top panel that is excluded from
// screen sharing, and enables system-audio loopback capture.

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme,
  powerSaveBlocker, screen, session, shell, systemPreferences,
} = require('electron');

// ---- switches that must be set before `ready` ------------------------------
if (process.env.RECAPPER_USER_DATA) {
  // Isolated profile (tests, second dev copy). Also scopes the single-instance lock.
  app.setPath('userData', path.resolve(process.env.RECAPPER_USER_DATA));
}
if (process.env.RECAPPER_TEST_FAKE_MEDIA === '1' || process.env.RECAPPER_TEST_FAKE_MEDIA === 'ui') {
  // Tests: Chromium's fake capture devices (the "microphone" is a beep).
  // getDisplayMedia still goes through electron-audio-loopback's handler.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  // 'ui': Chromium answers getDisplayMedia itself with fake screen + fake audio.
  // NOTE: this bypasses Electron's display-media handler (the loopback path).
  if (process.env.RECAPPER_TEST_FAKE_MEDIA === 'ui') app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
// electron-audio-loopback: registers the enable/disable-loopback-audio IPC
// handlers and the Chromium feature flags for system audio capture.
require('electron-audio-loopback').initMain({
  onAfterGetSources: (sources) => {
    // No screen sources on macOS = "Screen & System Audio Recording" not granted;
    // the library then never answers getDisplayMedia (capture.js times out).
    log(`loopback: ${sources.length} screen source(s)${sources.length ? '' : ' — check the Screen Recording permission'}`);
    return sources;
  },
});

const { BackendManager } = require('./backend');
const { t, normalizeLang } = require('./i18n');
const { requestJson } = require('./net');
const { DEFAULT_SETTINGS, normalizeSettings, settingsFromResponse, validateAccelerator } = require('./settings');
const { DesktopState, visibleBounds, defaultPanelBounds } = require('./state');
const { buildAppUrl, isBackendUrl, isLocalUiUrl, isPermissionAllowed, isSafeExternalUrl, navigationDecision } = require('./urls');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const UI_DIR = path.join(__dirname, 'ui');
const ASSETS = path.join(__dirname, 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ctx = {
  backend: null,
  backendOrigin: null,
  mainWindow: null,
  panelWindow: null,
  tray: null,
  settings: { ...DEFAULT_SETTINGS },
  hotkey: null,
  quitting: false,
  cleanedUp: false,
  capturing: false,
  powerBlocker: null,
  state: null,
  desktopLog: null,
};

// Exposed for E2E tests (read via electronApp.evaluate) and debugging.
global.__recapper = ctx;

function lang() {
  return normalizeLang(ctx.settings.ui_language);
}

function log(line) {
  const text = ctx.backend ? require('./command').redact(line, ctx.backend.token) : line;
  const stamped = `${new Date().toISOString()} ${text}`;
  if (!process.env.RECAPPER_QUIET) console.log(`[recapper] ${text}`);
  try {
    if (!ctx.desktopLog) {
      fs.mkdirSync(app.getPath('logs'), { recursive: true });
      ctx.desktopLog = fs.createWriteStream(path.join(app.getPath('logs'), 'desktop.log'), { flags: 'a' });
    }
    ctx.desktopLog.write(`${stamped}\n`);
  } catch {
    /* logging must never break the app */
  }
}

const alive = (w) => Boolean(w && !w.isDestroyed());

// ---- single instance ---------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(boot).catch((err) => {
    log(`boot failed: ${err && err.stack}`);
    dialog.showErrorBox('Recapper', String(err && err.message));
    app.exit(1);
  });
}

// ---- boot ----------------------------------------------------------------------
async function boot() {
  if (process.env.RECAPPER_USER_DATA) app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
  else app.setAppLogsPath();
  ctx.state = new DesktopState(path.join(app.getPath('userData'), 'desktop-state.json'));
  ctx.settings = normalizeSettings({ ui_language: ctx.state.get('lastLanguage', 'ru') });
  log(`Recapper ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}, packaged=${app.isPackaged})`);

  if (IS_MAC) app.setAboutPanelOptions({ applicationName: 'Recapper', applicationVersion: app.getVersion() });
  setupSecurity();
  setupIpc();
  buildMenu();
  createTray();
  createMainWindow();

  if (IS_MAC) {
    // Triggers the macOS microphone prompt once (NSMicrophoneUsageDescription).
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined') {
      systemPreferences.askForMediaAccess('microphone')
        .then((granted) => log(`microphone access: ${granted ? 'granted' : 'denied'}`))
        .catch((e) => log(`askForMediaAccess failed: ${e.message}`));
    } else {
      log(`microphone access: ${status}; screen: ${systemPreferences.getMediaAccessStatus('screen')}`);
    }
  }

  ctx.backend = new BackendManager({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: REPO_ROOT,
    dataDir: app.getPath('userData'),
    workDir: app.isPackaged ? app.getPath('userData') : undefined,
    logFile: path.join(app.getPath('logs'), 'backend.log'),
    readyTimeoutMs: Number(process.env.RECAPPER_BACKEND_TIMEOUT_MS) || 60_000,
  });
  ctx.backend.on('exit', onBackendExit);
  await startBackendAndLoad();
}

async function startBackendAndLoad() {
  const win = ctx.mainWindow;
  if (alive(win)) win.loadFile(path.join(UI_DIR, 'loading.html'), { query: { lang: lang() } });
  let info;
  try {
    info = await ctx.backend.start();
  } catch (err) {
    log(`backend failed to start: ${err.message}`);
    showBackendError(err);
    return false;
  }
  ctx.backendOrigin = info.url;
  log(`backend ready: ${info.url} (pid ${info.pid}, via ${info.readyVia})`);
  await loadSettingsFromBackend();
  if (alive(ctx.mainWindow)) await ctx.mainWindow.loadURL(buildAppUrl(info.url, info.token, 'main')).catch((e) => log(`main load failed: ${e.message}`));
  ensurePanelWindow();
  if (alive(ctx.panelWindow)) await ctx.panelWindow.loadURL(buildAppUrl(info.url, info.token, 'panel')).catch((e) => log(`panel load failed: ${e.message}`));
  return true;
}

function showBackendError(err) {
  if (!alive(ctx.mainWindow)) createMainWindow();
  const details = [err.command ? `$ ${err.command}` : '', ...(err.tail || [])].filter(Boolean).join('\n');
  ctx.mainWindow.loadFile(path.join(UI_DIR, 'error.html'), {
    query: {
      lang: lang(),
      title: t(lang(), 'errorTitle'),
      message: err.message,
      details: details.slice(-8000),
      log: ctx.backend ? ctx.backend.logFile || '' : '',
      kind: app.isPackaged ? 'packaged' : 'dev',
    },
  });
  showMainWindow();
}

async function onBackendExit({ code, signal, expected }) {
  if (expected || ctx.quitting) return;
  log(`backend crashed (code=${code}, signal=${signal})`);
  const { response } = await dialog.showMessageBox(alive(ctx.mainWindow) ? ctx.mainWindow : undefined, {
    type: 'error',
    title: t(lang(), 'crashTitle'),
    message: t(lang(), 'crashTitle'),
    detail: `${t(lang(), 'crashMessage')}\n\n${ctx.backend.tailText(12)}`,
    buttons: [t(lang(), 'crashRestart'), t(lang(), 'crashQuit')],
    defaultId: 0,
    cancelId: 1,
  });
  if (ctx.quitting) return;
  if (response === 0) await startBackendAndLoad();
  else app.quit();
}

async function loadSettingsFromBackend() {
  let values = null;
  try {
    const r = await requestJson(new URL('/api/settings', ctx.backendOrigin).toString(), {
      headers: { authorization: `Bearer ${ctx.backend.token}` },
      timeoutMs: 4000,
    });
    if (r.status === 200) values = settingsFromResponse(r.json);
    else log(`GET /api/settings -> ${r.status}; using defaults`);
  } catch (e) {
    log(`GET /api/settings failed (${e.message}); using defaults`);
  }
  const result = applySettings(values || {}, { initial: true });
  if (!result.ok) log(`initial settings: ${result.error}`);
}

// ---- settings --------------------------------------------------------------------
/**
 * Applies (partial) settings: theme, language (menus/tray), panel flags and the
 * global hotkey. An invalid or busy hotkey keeps the previous one and yields
 * {ok: false, error}; the other settings are still applied.
 */
function applySettings(values, { initial = false } = {}) {
  const next = normalizeSettings(values || {}, initial ? DEFAULT_SETTINGS : ctx.settings);
  const prevLang = lang();
  ctx.settings = next;
  if (ctx.state) ctx.state.set('lastLanguage', lang());

  try {
    nativeTheme.themeSource = next.theme;
  } catch (e) {
    log(`theme: ${e.message}`);
  }
  applyPanelFlags();
  const hk = registerHotkey(next.panel_hotkey);
  if (!hk.ok) ctx.settings.panel_hotkey = ctx.hotkey || next.panel_hotkey;
  if (initial || prevLang !== lang() || !hk.ok || hk.changed) {
    buildMenu();
    updateTray();
    if (alive(ctx.panelWindow)) ctx.panelWindow.setTitle(t(lang(), 'panelTitle'));
  }
  return hk.ok ? { ok: true, hotkey: ctx.hotkey } : { ok: false, error: hk.error, hotkey: ctx.hotkey };
}

function registerHotkey(accel) {
  if (accel === ctx.hotkey && ctx.hotkey && globalShortcut.isRegistered(ctx.hotkey)) return { ok: true, changed: false };
  const v = validateAccelerator(accel);
  if (!v.ok) {
    const error = t(lang(), 'hotkeyInvalid', { error: v.error });
    log(`hotkey ${JSON.stringify(accel)} rejected: ${v.error}`);
    return { ok: false, error };
  }
  let registered = false;
  try {
    registered = globalShortcut.register(accel, togglePanel);
  } catch (e) {
    log(`hotkey ${accel} threw: ${e.message}`);
    return { ok: false, error: t(lang(), 'hotkeyInvalid', { error: e.message }) };
  }
  if (!registered) {
    log(`hotkey ${accel} is taken by another application`);
    return { ok: false, error: t(lang(), 'hotkeyBusy', { accel }) };
  }
  if (ctx.hotkey && ctx.hotkey !== accel) {
    try {
      globalShortcut.unregister(ctx.hotkey);
    } catch {
      /* ignore */
    }
  }
  ctx.hotkey = accel;
  log(`panel hotkey: ${accel}`);
  return { ok: true, changed: true };
}

// ---- windows -----------------------------------------------------------------------
function webPreferences(view) {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    // Capture keeps running while the window is hidden/minimized.
    backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required',
    additionalArguments: [`--recapper-version=${app.getVersion()}`, `--recapper-view=${view}`],
  };
}

function windowIcon() {
  if (IS_MAC) return undefined;
  const img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  return img.isEmpty() ? undefined : img;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: 'Recapper',
    show: false,
    icon: windowIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#f7f7f5',
    webPreferences: webPreferences('main'),
  });
  ctx.mainWindow = win;
  win.once('ready-to-show', () => {
    if (process.env.RECAPPER_START_HIDDEN !== '1') win.show();
  });
  win.on('close', (e) => {
    if (ctx.quitting) return;
    if (IS_MAC) {
      // macOS convention: closing the window keeps the app (and capture) running.
      e.preventDefault();
      win.hide();
    } else {
      e.preventDefault();
      app.quit();
    }
  });
  win.on('closed', () => {
    if (ctx.mainWindow === win) ctx.mainWindow = null;
  });
  return win;
}

function panelBounds() {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const saved = visibleBounds(ctx.state && ctx.state.get('panelBounds'), displays);
  return saved || defaultPanelBounds(screen.getPrimaryDisplay().workArea);
}

function ensurePanelWindow() {
  if (alive(ctx.panelWindow)) return ctx.panelWindow;
  const b = panelBounds();
  const win = new BrowserWindow({
    ...b,
    minWidth: 300,
    minHeight: 360,
    title: t(lang(), 'panelTitle'),
    show: false,
    icon: windowIcon(),
    alwaysOnTop: ctx.settings.panel_always_on_top,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#f7f7f5',
    webPreferences: webPreferences('panel'),
  });
  ctx.panelWindow = win;
  applyPanelFlags();
  const saveBounds = () => {
    if (alive(win) && ctx.state) ctx.state.set('panelBounds', win.getBounds());
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('close', (e) => {
    if (ctx.quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('show', updateMenusForPanel);
  win.on('hide', updateMenusForPanel);
  win.on('closed', () => {
    if (ctx.panelWindow === win) ctx.panelWindow = null;
  });
  return win;
}

function applyPanelFlags() {
  const win = ctx.panelWindow;
  if (!alive(win)) return;
  const onTop = Boolean(ctx.settings.panel_always_on_top);
  const hidden = Boolean(ctx.settings.panel_hide_from_screen_share);
  win.setAlwaysOnTop(onTop, 'floating');
  // Excluded from screen sharing/recording: macOS NSWindowSharingNone,
  // Windows WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+).
  win.setContentProtection(hidden);
  ctx.panelContentProtection = hidden;
  if (IS_MAC) win.setVisibleOnAllWorkspaces(onTop, { visibleOnFullScreen: onTop });
}

function showMainWindow() {
  if (!alive(ctx.mainWindow)) {
    createMainWindow();
    if (ctx.backendOrigin) ctx.mainWindow.loadURL(buildAppUrl(ctx.backendOrigin, ctx.backend.token, 'main'));
  }
  const win = ctx.mainWindow;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showPanel() {
  if (!ctx.backendOrigin) return false;
  const win = ensurePanelWindow();
  if (!win.webContents.getURL()) win.loadURL(buildAppUrl(ctx.backendOrigin, ctx.backend.token, 'panel'));
  applyPanelFlags();
  win.showInactive(); // do not steal focus from the call window
  return true;
}

function hidePanel() {
  if (alive(ctx.panelWindow)) ctx.panelWindow.hide();
  return false;
}

function togglePanel() {
  if (alive(ctx.panelWindow) && ctx.panelWindow.isVisible()) return hidePanel();
  return showPanel();
}

function panelVisible() {
  return alive(ctx.panelWindow) && ctx.panelWindow.isVisible();
}

// ---- menu & tray -------------------------------------------------------------------------
function buildMenu() {
  const L = (k) => t(lang(), k);
  const panelItem = {
    label: panelVisible() ? L('menuHidePanel') : L('menuShowPanel'),
    accelerator: ctx.hotkey || undefined,
    registerAccelerator: false, // the global shortcut already handles it
    click: () => togglePanel(),
  };
  const template = [
    ...(IS_MAC ? [{
      label: L('menuApp'),
      submenu: [
        { role: 'about', label: L('menuAbout') },
        { type: 'separator' },
        { role: 'hide', label: L('menuHide') },
        { role: 'hideOthers', label: L('menuHideOthers') },
        { role: 'unhide', label: L('menuShowAll') },
        { type: 'separator' },
        { role: 'quit', label: L('menuQuit') },
      ],
    }] : [{
      label: L('menuFile'),
      submenu: [{ role: 'close', label: L('menuClose') }, { type: 'separator' }, { role: 'quit', label: L('menuQuit') }],
    }]),
    {
      label: L('menuEdit'),
      submenu: [
        { role: 'undo', label: L('menuUndo') },
        { role: 'redo', label: L('menuRedo') },
        { type: 'separator' },
        { role: 'cut', label: L('menuCut') },
        { role: 'copy', label: L('menuCopy') },
        { role: 'paste', label: L('menuPaste') },
        { role: 'selectAll', label: L('menuSelectAll') },
      ],
    },
    {
      label: L('menuView'),
      submenu: [
        panelItem,
        { label: L('menuShowMain'), click: () => showMainWindow() },
        { type: 'separator' },
        { role: 'reload', label: L('menuReload') },
        { role: 'zoomIn', label: L('menuZoomIn') },
        { role: 'zoomOut', label: L('menuZoomOut') },
        { role: 'resetZoom', label: L('menuZoomReset') },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools', label: L('menuDevTools') }]),
      ],
    },
    { label: L('menuWindow'), submenu: [{ role: 'minimize', label: L('menuMinimize') }, { role: 'close', label: L('menuClose') }] },
    {
      label: L('menuHelp'),
      submenu: [
        { label: L('menuOpenLogs'), click: () => openLogs() },
        { label: L('menuRestartBackend'), click: () => restartBackend() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayImage() {
  const rec = ctx.capturing ? 'Rec' : '';
  const file = IS_MAC ? `tray${rec}Template.png` : `tray${rec}.png`;
  const img = nativeImage.createFromPath(path.join(ASSETS, file));
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}

function createTray() {
  try {
    ctx.tray = new Tray(trayImage());
    if (!IS_MAC) ctx.tray.on('click', () => togglePanel());
    updateTray();
  } catch (e) {
    log(`tray unavailable: ${e.message}`);
    ctx.tray = null;
  }
}

function updateTray() {
  if (!ctx.tray) return;
  const L = (k) => t(lang(), k);
  ctx.tray.setImage(trayImage());
  ctx.tray.setToolTip(L('trayTooltip'));
  ctx.tray.setContextMenu(Menu.buildFromTemplate([
    { label: panelVisible() ? L('menuHidePanel') : L('menuShowPanel'), accelerator: ctx.hotkey || undefined, registerAccelerator: false, click: () => togglePanel() },
    { label: L('menuShowMain'), click: () => showMainWindow() },
    { type: 'separator' },
    { label: L('menuOpenLogs'), click: () => openLogs() },
    { type: 'separator' },
    { label: L('trayQuit'), click: () => app.quit() },
  ]));
}

function updateMenusForPanel() {
  buildMenu();
  updateTray();
}

function openLogs() {
  shell.openPath(app.getPath('logs')).catch(() => {});
}

async function restartBackend() {
  if (!ctx.backend) return;
  await stopCaptureInWindows();
  await ctx.backend.stop();
  ctx.backendOrigin = null;
  await startBackendAndLoad();
}

// ---- security ----------------------------------------------------------------------------
function setupSecurity() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const ok = isPermissionAllowed(permission, url, ctx.backendOrigin, details || {});
    if (!ok) log(`permission denied: ${permission} for ${url} ${JSON.stringify((details && details.mediaTypes) || [])}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const url = (details && (details.requestingUrl || details.securityOrigin)) || requestingOrigin;
    const mediaTypes = details && details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [];
    return isPermissionAllowed(permission, url, ctx.backendOrigin, { mediaTypes });
  });

  app.on('web-contents-created', (_e, contents) => {
    const guard = (event, url) => {
      const decision = navigationDecision(url, { backendOrigin: ctx.backendOrigin, uiDir: UI_DIR });
      if (decision === 'allow') return;
      event.preventDefault();
      if (decision === 'external') shell.openExternal(url).catch(() => {});
      else log(`blocked navigation to ${url}`);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isBackendUrl(url, ctx.backendOrigin)) {
        const u = new URL(url);
        if (u.searchParams.get('view') === 'panel') showPanel();
        else showMainWindow();
        return { action: 'deny' };
      }
      if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
      else log(`blocked window.open(${url})`);
      return { action: 'deny' };
    });
  });
}

function isTrustedSender(event, { allowLocalUi = false } = {}) {
  const wc = event.sender;
  const ours = [ctx.mainWindow, ctx.panelWindow].some((w) => alive(w) && w.webContents === wc);
  if (!ours) return false;
  const url = (event.senderFrame && event.senderFrame.url) || wc.getURL();
  if (isBackendUrl(url, ctx.backendOrigin)) return true;
  return allowLocalUi && isLocalUiUrl(url, UI_DIR);
}

function setupIpc() {
  const handle = (channel, fn, opts) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event, opts)) throw new Error('forbidden');
      return fn(...args);
    });
  };
  handle('recapper:panel', (action) => {
    if (action === 'show') return showPanel();
    if (action === 'hide') return hidePanel();
    return togglePanel();
  });
  handle('recapper:show-main', () => {
    showMainWindow();
    return true;
  });
  handle('recapper:apply-settings', (values) => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: 'values must be an object' };
    return applySettings(values);
  });
  handle('recapper:set-capturing', (on) => {
    setCapturing(Boolean(on));
    return true;
  });
  handle('recapper:media-access', () => mediaAccess());
  handle('recapper:open-privacy', (kind) => openPrivacySettings(kind));
  handle('recapper:open-logs', () => {
    openLogs();
    return true;
  }, { allowLocalUi: true });
  handle('recapper:retry-backend', async () => {
    await ctx.backend.stop();
    return startBackendAndLoad();
  }, { allowLocalUi: true });
}

function setCapturing(on) {
  if (ctx.capturing === on) return;
  ctx.capturing = on;
  // Keep macOS App Nap / Windows power throttling away while recording.
  if (on && ctx.powerBlocker === null) ctx.powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && ctx.powerBlocker !== null) {
    powerSaveBlocker.stop(ctx.powerBlocker);
    ctx.powerBlocker = null;
  }
  updateTray();
}

function mediaAccess() {
  if (IS_MAC || IS_WIN) {
    const get = (k) => {
      try {
        return systemPreferences.getMediaAccessStatus(k);
      } catch {
        return 'unknown';
      }
    };
    return { microphone: get('microphone'), screen: IS_MAC ? get('screen') : 'granted' };
  }
  return { microphone: 'unknown', screen: 'unknown' };
}

function openPrivacySettings(kind) {
  const urls = IS_MAC
    ? {
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    }
    : IS_WIN ? { microphone: 'ms-settings:privacy-microphone', screen: 'ms-settings:privacy-microphone' } : {};
  const url = urls[kind];
  if (!url) return false;
  shell.openExternal(url).catch(() => {});
  return true;
}

// ---- shutdown --------------------------------------------------------------------------------
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

/** Lets a running RecapperCapture upload its last partial chunk. */
async function stopCaptureInWindows() {
  const js = 'window.RecapperCapture && window.RecapperCapture.running ? window.RecapperCapture.stop().then(() => true) : false';
  const wins = [ctx.mainWindow, ctx.panelWindow].filter((w) => alive(w) && isBackendUrl(w.webContents.getURL(), ctx.backendOrigin));
  await Promise.all(wins.map((w) => withTimeout(w.webContents.executeJavaScript(js, true).catch(() => false), 5000, false)));
}

app.on('before-quit', (e) => {
  ctx.quitting = true;
  if (ctx.cleanedUp) return;
  e.preventDefault();
  (async () => {
    try {
      await stopCaptureInWindows();
      if (ctx.backend) await ctx.backend.stop();
    } catch (err) {
      log(`shutdown: ${err.message}`);
    } finally {
      ctx.cleanedUp = true;
      if (ctx.state) ctx.state.flush();
      if (ctx.backend) ctx.backend.close();
      log('bye');
      app.quit();
    }
  })();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('activate', () => {
  if (ctx.backend) showMainWindow();
});

process.on('exit', () => {
  if (ctx.backend) ctx.backend.killSync();
});
