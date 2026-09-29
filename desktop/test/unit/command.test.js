'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  generateToken, defaultPython, resolvePython, splitCommand, parseCommandOverride, packagedServerPath,
  buildBackendCommand, buildBackendEnv, redact, describeCommand,
} = require('../../src/command');

const TOKEN = 'f'.repeat(48);
const base = { host: '127.0.0.1', port: 50123, token: TOKEN, exists: () => false };
const SERVE = ['serve', '--host', '127.0.0.1', '--port', '50123', '--token', TOKEN];

test('generateToken: 48 hex chars, random', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test('python defaults per platform and overrides', () => {
  assert.equal(defaultPython('darwin'), 'python3');
  assert.equal(defaultPython('linux'), 'python3');
  assert.equal(defaultPython('win32'), 'python');
  assert.equal(resolvePython({ env: { RECAPPER_PYTHON: ' /opt/py/bin/python3.12 ' }, platform: 'darwin' }), '/opt/py/bin/python3.12');
  assert.equal(resolvePython({ env: {}, platform: 'win32', exists: () => false, repoRoot: 'C:\\repo' }), 'python');
  const venv = path.join('/repo', '.venv', 'bin', 'python');
  assert.equal(resolvePython({ env: {}, platform: 'linux', repoRoot: '/repo', exists: (p) => p === venv }), venv);
  const winVenv = path.join('C:\\repo', '.venv', 'Scripts', 'python.exe');
  assert.equal(resolvePython({ env: {}, platform: 'win32', repoRoot: 'C:\\repo', exists: (p) => p === winVenv }), winVenv);
  // RECAPPER_PYTHON beats the venv
  assert.equal(resolvePython({ env: { RECAPPER_PYTHON: 'py' }, platform: 'linux', repoRoot: '/repo', exists: () => true }), 'py');
});

test('splitCommand handles quotes, escapes and Windows paths', () => {
  assert.deepEqual(splitCommand('python3 -m recapper'), ['python3', '-m', 'recapper']);
  assert.deepEqual(splitCommand('  "/path with space/python" \'a b\'  c  '), ['/path with space/python', 'a b', 'c']);
  assert.deepEqual(splitCommand('C:\\Python311\\python.exe fake.py'), ['C:\\Python311\\python.exe', 'fake.py']);
  assert.deepEqual(splitCommand('echo "say \\"hi\\"" x\\ y'), ['echo', 'say "hi"', 'x y']);
  assert.deepEqual(splitCommand('a "" b'), ['a', '', 'b']);
  assert.throws(() => splitCommand('python "unterminated'), /кавычк/);
});

test('parseCommandOverride: JSON array or string; rejects junk', () => {
  assert.equal(parseCommandOverride(undefined), null);
  assert.equal(parseCommandOverride('   '), null);
  assert.deepEqual(parseCommandOverride('["python3", "fake.py", 1]'), ['python3', 'fake.py', '1']);
  assert.deepEqual(parseCommandOverride('python3 /tmp/fake.py'), ['python3', '/tmp/fake.py']);
  assert.throws(() => parseCommandOverride('[1, {"a": 2}]'), /JSON-массив/);
  assert.throws(() => parseCommandOverride('[not json'), /JSON/);
  assert.throws(() => parseCommandOverride('[]'), /пустая/);
});

test('dev command: python -m recapper serve in the repo root', () => {
  const cmd = buildBackendCommand({ ...base, env: {}, platform: 'darwin', repoRoot: '/repo' });
  assert.deepEqual(cmd, { command: 'python3', args: ['-m', 'recapper', ...SERVE], cwd: '/repo', kind: 'dev' });
  const win = buildBackendCommand({ ...base, env: {}, platform: 'win32', repoRoot: 'C:\\repo' });
  assert.equal(win.command, 'python');
  const custom = buildBackendCommand({ ...base, env: { RECAPPER_PYTHON: '/usr/bin/python3.11' }, platform: 'linux', repoRoot: '/r' });
  assert.equal(custom.command, '/usr/bin/python3.11');
});

test('packaged command: resources/backend/recapper-server[.exe]', () => {
  const mac = buildBackendCommand({ ...base, env: {}, platform: 'darwin', isPackaged: true, resourcesPath: '/App.app/Contents/Resources', workDir: '/data' });
  assert.equal(mac.command, path.join('/App.app/Contents/Resources', 'backend', 'recapper-server'));
  assert.deepEqual(mac.args, SERVE);
  assert.equal(mac.cwd, '/data');
  assert.equal(mac.kind, 'packaged');
  assert.equal(packagedServerPath('C:\\Program Files\\Recapper\\resources', 'win32'),
    path.join('C:\\Program Files\\Recapper\\resources', 'backend', 'recapper-server.exe'));
  assert.throws(() => buildBackendCommand({ ...base, env: {}, isPackaged: true }), /resourcesPath/);
});

test('override command: appends serve args, or substitutes placeholders', () => {
  const env = { RECAPPER_BACKEND_CMD: '["python3", "/t/fake_backend.py"]', RECAPPER_PYTHON: 'ignored' };
  const cmd = buildBackendCommand({ ...base, env, platform: 'linux', repoRoot: '/r', isPackaged: true, resourcesPath: '/res' });
  assert.equal(cmd.kind, 'override');
  assert.equal(cmd.command, 'python3');
  assert.deepEqual(cmd.args, ['/t/fake_backend.py', ...SERVE]);
  const ph = buildBackendCommand({ ...base, env: { RECAPPER_BACKEND_CMD: 'node srv.js --listen {host}:{port} --auth={token}' }, repoRoot: '/r' });
  assert.deepEqual([ph.command, ...ph.args], ['node', 'srv.js', '--listen', '127.0.0.1:50123', `--auth=${TOKEN}`]);
});

test('port and token are mandatory', () => {
  assert.throws(() => buildBackendCommand({ ...base, port: 0, env: {} }), /port/);
  assert.throws(() => buildBackendCommand({ ...base, token: '', env: {} }), /token/);
});

test('backend env: unbuffered python, token, data dir, no test switches', () => {
  const env = buildBackendEnv({
    baseEnv: { PATH: '/bin', RECAPPER_BACKEND_CMD: 'x', ELECTRON_RUN_AS_NODE: '1', RECAPPER_LLM: 'sim-good' },
    token: TOKEN, dataDir: '/data', parentPid: 42,
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.PYTHONUNBUFFERED, '1');
  assert.equal(env.RECAPPER_API_TOKEN, TOKEN);
  assert.equal(env.RECAPPER_DATA_DIR, '/data');
  assert.ok(!('RECAPPER_DB' in env), 'db location is left to the backend (inside the data dir)');
  assert.equal(env.RECAPPER_PARENT_PID, '42');
  assert.equal(env.RECAPPER_DESKTOP, '1');
  assert.equal(env.RECAPPER_LLM, 'sim-good');
  assert.ok(!('RECAPPER_BACKEND_CMD' in env));
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env));
  const keep = buildBackendEnv({ baseEnv: { RECAPPER_DATA_DIR: '/mine' }, token: TOKEN, dataDir: '/data' });
  assert.equal(keep.RECAPPER_DATA_DIR, '/mine', 'user choice wins');
  const none = buildBackendEnv({ baseEnv: {}, token: TOKEN });
  assert.ok(!('RECAPPER_DATA_DIR' in none), 'backend default (~/.recapper) when not configured');
});

test('the token never appears in printable command lines', () => {
  const cmd = buildBackendCommand({ ...base, env: {}, platform: 'linux', repoRoot: '/r' });
  const s = describeCommand(cmd, TOKEN);
  assert.ok(!s.includes(TOKEN));
  assert.match(s, /--token \*\*\*/);
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a *** b ***');
  assert.equal(redact('abc', ''), 'abc');
  assert.equal(describeCommand({ command: '/a b/python', args: ['x'] }, TOKEN), '"/a b/python" x');
});
