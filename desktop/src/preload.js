'use strict';
// Preload (sandboxed, contextIsolation): the only bridge between the backend
// web UI and the desktop shell. Everything goes through ipcRenderer.invoke;
// the main process validates the sender of every call.

const { contextBridge, ipcRenderer } = require('electron');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = (process.argv || []).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const bridge = {
  platform: process.platform,
  version: argValue('recapper-version'),
  view: argValue('recapper-view') || 'main',
  // Whether this OS can hide the panel from screen sharing/recording
  // (macOS: NSWindowSharingNone; Windows 10 2004+: WDA_EXCLUDEFROMCAPTURE).
  // Linux: not supported. Whether it is switched on is the
  // `panel_hide_from_screen_share` setting.
  contentProtection: process.platform === 'darwin' || process.platform === 'win32',

  // System audio loopback (electron-audio-loopback). Call enable, then
  // navigator.mediaDevices.getDisplayMedia({video: true, audio: true}),
  // then disable. RecapperCapture (capture.js) does this for you.
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),

  // Floating panel (always on top, hidden from screen sharing).
  togglePanel: () => ipcRenderer.invoke('recapper:panel', 'toggle'),
  showPanel: () => ipcRenderer.invoke('recapper:panel', 'show'),
  hidePanel: () => ipcRenderer.invoke('recapper:panel', 'hide'),
  showMainWindow: () => ipcRenderer.invoke('recapper:show-main'),

  // Apply saved settings live (hotkey, panel flags, language, theme).
  // Resolves {ok: true} or {ok: false, error}.
  applySettings: (values) => ipcRenderer.invoke('recapper:apply-settings', values),

  // capture.js reports recording state: tray indicator + no App Nap while recording.
  setCapturing: (on) => ipcRenderer.invoke('recapper:set-capturing', Boolean(on)),

  // macOS privacy status: {microphone, screen} = 'granted' | 'denied' | 'not-determined' | ...
  getMediaAccess: () => ipcRenderer.invoke('recapper:media-access'),
  openPrivacySettings: (kind) => ipcRenderer.invoke('recapper:open-privacy', kind),

  openLogs: () => ipcRenderer.invoke('recapper:open-logs'),
  retryBackend: () => ipcRenderer.invoke('recapper:retry-backend'),
};

contextBridge.exposeInMainWorld('recapperDesktop', Object.freeze(bridge));
