'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  parseReadyLine, buildAppUrl, originOf, isBackendUrl, isLocalUiUrl, isSafeExternalUrl,
  navigationDecision, isPermissionAllowed,
} = require('../../src/urls');

const ORIGIN = 'http://127.0.0.1:53123';

test('parseReadyLine accepts the contract line and rejects noise', () => {
  assert.equal(parseReadyLine('RECAPPER_READY http://127.0.0.1:53123'), ORIGIN);
  assert.equal(parseReadyLine('RECAPPER_READY http://127.0.0.1:53123/  \r'), ORIGIN);
  assert.equal(parseReadyLine('  RECAPPER_READY http://127.0.0.1:8000\n'), 'http://127.0.0.1:8000');
  assert.equal(parseReadyLine('INFO: Uvicorn running on http://127.0.0.1:8000'), null);
  assert.equal(parseReadyLine('RECAPPER_READY'), null);
  assert.equal(parseReadyLine('RECAPPER_READY not-a-url'), null);
  assert.equal(parseReadyLine('xRECAPPER_READY http://127.0.0.1:1'), null);
});

test('buildAppUrl adds token and view', () => {
  const token = 'ab'.repeat(24);
  assert.equal(buildAppUrl(ORIGIN, token), `${ORIGIN}/?token=${token}`);
  assert.equal(buildAppUrl(ORIGIN, token, 'panel'), `${ORIGIN}/?token=${token}&view=panel`);
  assert.equal(buildAppUrl(`${ORIGIN}/`, token, 'main'), `${ORIGIN}/?token=${token}`);
  const u = new URL(buildAppUrl(ORIGIN, 'a b&c', 'panel'));
  assert.equal(u.searchParams.get('token'), 'a b&c');
});

test('origin checks are exact (scheme, host and port)', () => {
  assert.equal(originOf('http://127.0.0.1:53123/x?y'), ORIGIN);
  assert.equal(originOf('garbage'), null);
  assert.ok(isBackendUrl(`${ORIGIN}/api/live`, ORIGIN));
  assert.ok(isBackendUrl(`${ORIGIN}/?token=1&view=panel`, `${ORIGIN}/`));
  assert.ok(!isBackendUrl('http://127.0.0.1:53124/', ORIGIN));
  assert.ok(!isBackendUrl('https://127.0.0.1:53123/', ORIGIN));
  assert.ok(!isBackendUrl('http://localhost:53123/', ORIGIN));
  assert.ok(!isBackendUrl('http://127.0.0.1:53123.evil.com/', ORIGIN));
  assert.ok(!isBackendUrl(`${ORIGIN}/`, null));
  assert.ok(!isBackendUrl('file:///etc/passwd', ORIGIN));
  assert.ok(!isBackendUrl('data:text/html,hi', ORIGIN));
});

test('local UI pages are recognised only inside the ui directory', () => {
  const uiDir = path.resolve(__dirname, '..', '..', 'src', 'ui');
  assert.ok(isLocalUiUrl(pathToFileURL(path.join(uiDir, 'error.html')).href + '?lang=ru', uiDir));
  assert.ok(!isLocalUiUrl(pathToFileURL(path.join(uiDir, '..', 'main.js')).href, uiDir));
  assert.ok(!isLocalUiUrl(pathToFileURL(`${uiDir}-evil/x.html`).href, uiDir));
  assert.ok(!isLocalUiUrl('http://127.0.0.1/', uiDir));
  assert.ok(!isLocalUiUrl('file:///x.html', null));
});

test('only http(s) links go to the external browser', () => {
  assert.ok(isSafeExternalUrl('https://example.com/a?b'));
  assert.ok(isSafeExternalUrl('http://example.com'));
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://host/share', 'data:text/html,x',
    'ms-settings:privacy', 'x-apple.systempreferences:foo', 'vbscript:x', '', 'not a url']) {
    assert.ok(!isSafeExternalUrl(bad), bad);
  }
});

test('navigationDecision: allow backend + local ui, external for web, deny the rest', () => {
  const uiDir = path.resolve(__dirname, '..', '..', 'src', 'ui');
  const opts = { backendOrigin: ORIGIN, uiDir };
  assert.equal(navigationDecision(`${ORIGIN}/report/1`, opts), 'allow');
  assert.equal(navigationDecision(pathToFileURL(path.join(uiDir, 'loading.html')).href, opts), 'allow');
  assert.equal(navigationDecision('https://docs.example.com', opts), 'external');
  assert.equal(navigationDecision('http://127.0.0.1:9999/', opts), 'external');
  assert.equal(navigationDecision('file:///etc/passwd', opts), 'deny');
  assert.equal(navigationDecision('javascript:alert(1)', opts), 'deny');
  assert.equal(navigationDecision('chrome://gpu', opts), 'deny');
});

test('permission policy: microphone (+clipboard write) for the backend origin only', () => {
  assert.ok(isPermissionAllowed('media', `${ORIGIN}/`, ORIGIN, { mediaTypes: ['audio'] }));
  assert.ok(isPermissionAllowed('media', `${ORIGIN}/?view=panel`, ORIGIN, {}));
  assert.ok(isPermissionAllowed('clipboard-sanitized-write', `${ORIGIN}/`, ORIGIN));
  assert.ok(!isPermissionAllowed('media', `${ORIGIN}/`, ORIGIN, { mediaTypes: ['audio', 'video'] }), 'camera');
  assert.ok(!isPermissionAllowed('media', 'https://evil.example/', ORIGIN, { mediaTypes: ['audio'] }));
  assert.ok(!isPermissionAllowed('media', 'file:///x.html', ORIGIN, { mediaTypes: ['audio'] }));
  assert.ok(!isPermissionAllowed('media', `${ORIGIN}/`, null, { mediaTypes: ['audio'] }), 'before backend is up');
  for (const p of ['geolocation', 'notifications', 'midi', 'openExternal', 'clipboard-read', 'hid', 'usb', 'display-capture']) {
    assert.ok(!isPermissionAllowed(p, `${ORIGIN}/`, ORIGIN), p);
  }
});
