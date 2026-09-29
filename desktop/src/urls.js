'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Pure helpers for URLs, origins, navigation and permission policy.
// No Electron imports here: everything is unit-tested with `node --test`.

const READY_RE = /^RECAPPER_READY\s+(https?:\/\/\S+)\s*$/;

/** Parses the backend's readiness line (`RECAPPER_READY http://127.0.0.1:<port>`). */
function parseReadyLine(line) {
  const m = READY_RE.exec(String(line).trim());
  if (!m) return null;
  try {
    const u = new URL(m[1]);
    return u.origin;
  } catch {
    return null;
  }
}

/** URL of the backend web UI for the given view ('main' | 'panel'). */
function buildAppUrl(baseUrl, token, view = 'main') {
  const u = new URL('/', baseUrl);
  u.searchParams.set('token', token);
  if (view && view !== 'main') u.searchParams.set('view', view);
  return u.toString();
}

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'file://';
    return u.origin;
  } catch {
    return null;
  }
}

/** True when `url` belongs exactly to the backend origin (scheme + host + port). */
function isBackendUrl(url, backendOrigin) {
  if (!backendOrigin) return false;
  const o = originOf(url);
  return o !== null && o !== 'null' && o === originOf(backendOrigin);
}

/** Local pages bundled with the app (loading/error screens), identified by absolute directory. */
function isLocalUiUrl(url, uiDir) {
  if (!uiDir) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    const file = path.resolve(fileURLToPath(u));
    const dir = path.resolve(uiDir) + path.sep;
    return file.startsWith(dir);
  } catch {
    return false;
  }
}

/** Only plain web links may be handed to the OS browser. */
function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Decides what to do with a navigation / window.open request.
 * Returns 'allow' (stay in the app), 'external' (open in default browser) or 'deny'.
 */
function navigationDecision(url, { backendOrigin, uiDir } = {}) {
  if (isBackendUrl(url, backendOrigin)) return 'allow';
  if (isLocalUiUrl(url, uiDir)) return 'allow';
  if (isSafeExternalUrl(url)) return 'external';
  return 'deny';
}

// Permissions the backend UI may use. `media` is microphone capture (and the
// loopback stream obtained through getDisplayMedia); clipboard write is used
// by "copy answer" buttons. Everything else (geolocation, notifications,
// camera, midi, usb, ...) is denied.
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);

/**
 * Permission policy.
 * @param {string} permission Electron permission name
 * @param {string} requestingUrl URL (or origin) of the frame asking
 * @param {string} backendOrigin e.g. http://127.0.0.1:53123
 * @param {{mediaTypes?: string[]}} [details]
 */
function isPermissionAllowed(permission, requestingUrl, backendOrigin, details = {}) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (!isBackendUrl(requestingUrl, backendOrigin)) return false;
  if (permission === 'media') {
    // Microphone only: never grant the camera.
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    if (types.includes('video')) return false;
  }
  return true;
}

module.exports = {
  parseReadyLine,
  buildAppUrl,
  originOf,
  isBackendUrl,
  isLocalUiUrl,
  isSafeExternalUrl,
  navigationDecision,
  isPermissionAllowed,
  ALLOWED_PERMISSIONS,
};
