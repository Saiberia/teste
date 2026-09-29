'use strict';
// BackendManager against the real fake backend process (Python stdlib).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BackendManager } = require('../../src/backend');
const { requestJson } = require('../../src/net');

const FAKE = path.resolve(__dirname, '..', 'fixtures', 'fake_backend.py');
const PYTHON = process.env.RECAPPER_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recapper-backend-'));
}

function manager(extraEnv = {}, opts = {}) {
  const dir = tmpDir();
  const env = { ...process.env, RECAPPER_BACKEND_CMD: JSON.stringify([PYTHON, FAKE]), ...extraEnv };
  const m = new BackendManager({
    env,
    repoRoot: dir,
    dataDir: dir,
    logFile: path.join(dir, 'logs', 'backend.log'),
    readyTimeoutMs: 15_000,
    healthIntervalMs: 100,
    stopTimeoutMs: 3000,
    ...opts,
  });
  m.dir = dir;
  return m;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

test('starts via READY line, passes host/port/token, answers with auth, stops cleanly', async () => {
  const m = manager();
  try {
    const info = await m.start();
    assert.equal(info.readyVia, 'ready-line');
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(info.token, /^[0-9a-f]{48}$/);
    assert.equal(m.state, 'ready');

    const health = await requestJson(`${info.url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');

    const noAuth = await requestJson(`${info.url}/__test__/info`);
    assert.equal(noAuth.status, 401);
    const r = await requestJson(`${info.url}/__test__/info`, { headers: { authorization: `Bearer ${info.token}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.argv, ['serve', '--host', '127.0.0.1', '--port', String(info.port), '--token', info.token]);
    assert.equal(r.json.env_token, true, 'token also passed as RECAPPER_API_TOKEN');
    assert.equal(r.json.data_dir, m.dir, 'RECAPPER_DATA_DIR passed to the backend');
    assert.equal(r.json.pid, info.pid);

    // concurrent start() calls share the running process
    const again = await m.start();
    assert.equal(again.pid, info.pid);

    const pid = info.pid;
    await m.stop();
    assert.equal(m.state, 'stopped');
    assert.ok(await waitDead(pid), 'backend process is gone after stop()');
    await m.stop(); // idempotent
  } finally {
    await m.stop();
    m.close();
  }
});

test('log file captures stderr and never contains the token', async () => {
  const m = manager();
  try {
    const info = await m.start();
    await requestJson(`${info.url}/api/health`);
    await m.stop();
    m.close();
    await new Promise((r) => setTimeout(r, 100));
    const text = fs.readFileSync(m.logFile, 'utf8');
    assert.match(text, /\[stderr\] fake backend starting/);
    assert.match(text, /\[stdout\] RECAPPER_READY/);
    assert.match(text, /--token \*\*\*/);
    assert.ok(!text.includes(info.token), 'token redacted');
  } finally {
    await m.stop();
    m.close();
  }
});

test('falls back to /api/health polling when the READY line is missing', async () => {
  const m = manager({ FAKE_NO_READY_LINE: '1' });
  try {
    const info = await m.start();
    assert.equal(info.readyVia, 'health');
  } finally {
    await m.stop();
    m.close();
  }
});

test('concurrent start() calls spawn exactly one process', async () => {
  const m = manager({ FAKE_READY_DELAY: '0.5' });
  try {
    const [a, b, c] = await Promise.all([m.start(), m.start(), m.start()]);
    assert.equal(a.pid, b.pid);
    assert.equal(b.pid, c.pid);
  } finally {
    await m.stop();
    m.close();
  }
});

test('early exit rejects with the exit code and stderr tail', async () => {
  const m = manager({ FAKE_EXIT_CODE: '3' });
  try {
    await assert.rejects(m.start(), (err) => {
      assert.equal(err.name, 'BackendStartError');
      assert.equal(err.code, 'exited');
      assert.equal(err.exitCode, 3);
      assert.ok(err.tail.some((l) => l.includes('simulated startup failure')), err.tail.join('\n'));
      assert.ok(!err.command.includes(m.token));
      return true;
    });
    assert.equal(m.state, 'failed');
  } finally {
    await m.stop();
    m.close();
  }
});

test('readiness timeout kills the hung process', async () => {
  const m = manager({ FAKE_HANG: '1' }, { readyTimeoutMs: 1500 });
  let pid = null;
  m.on('log', ({ line }) => {
    const hit = /pid=(\d+)/.exec(line);
    if (hit) pid = Number(hit[1]);
  });
  try {
    await assert.rejects(m.start(), (err) => err.code === 'timeout' && /не ответил/.test(err.message));
    assert.ok(pid, 'saw the pid in the log');
    assert.ok(await waitDead(pid), 'hung backend was killed');
  } finally {
    await m.stop();
    m.close();
  }
});

test('missing interpreter gives a clear spawn error', async () => {
  const m = manager({ RECAPPER_BACKEND_CMD: '["/nonexistent/python-xyz", "x.py"]' });
  try {
    await assert.rejects(m.start(), (err) => err.code === 'spawn_failed' && /ENOENT/.test(err.message));
  } finally {
    await m.stop();
    m.close();
  }
});

test('missing packaged binary is reported without spawning', async () => {
  const env = { ...process.env };
  delete env.RECAPPER_BACKEND_CMD;
  const dir = tmpDir();
  const m = new BackendManager({ env, isPackaged: true, resourcesPath: dir, dataDir: dir, workDir: dir, readyTimeoutMs: 2000 });
  try {
    await assert.rejects(m.start(), (err) => err.code === 'missing_binary' && err.message.includes('recapper-server'));
  } finally {
    await m.stop();
    m.close();
  }
});

test('restart gets a fresh process; unexpected exit is reported as a crash', async () => {
  const m = manager();
  try {
    const first = await m.start();
    const second = await m.restart();
    assert.notEqual(first.pid, second.pid);
    assert.ok(await waitDead(first.pid));
    assert.equal(second.token, first.token, 'token is stable for the app run');

    const exited = new Promise((resolve) => m.once('exit', resolve));
    process.kill(second.pid, 'SIGKILL');
    const ev = await exited;
    assert.equal(ev.expected, false);
    assert.equal(m.state, 'crashed');
    const third = await m.start();
    assert.equal(m.state, 'ready');
    assert.notEqual(third.pid, second.pid);
  } finally {
    await m.stop();
    m.close();
  }
});

test('the backend exits when its stdin closes (desktop app died)', async () => {
  const m = manager();
  try {
    const info = await m.start();
    m.child.stdin.end();
    assert.ok(await waitDead(info.pid, 5000), 'fake backend honours stdin EOF');
  } finally {
    await m.stop();
    m.close();
  }
});
