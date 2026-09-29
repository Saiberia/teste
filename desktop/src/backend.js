'use strict';
// Launches and supervises the Python backend (dev: `python -m recapper serve`,
// packaged: the PyInstaller `recapper-server` binary). No Electron imports:
// main.js passes in everything Electron-specific, so this is unit-testable.

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { buildBackendCommand, buildBackendEnv, describeCommand, generateToken, redact } = require('./command');
const { findFreePort, probeHealth } = require('./net');
const { parseReadyLine } = require('./urls');

const PORT_IN_USE_RE = /address already in use|Errno 98|Errno 48|error while attempting to bind|WinError 10048|WinError 10013/i;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const TAIL_LINES = 200;

class BackendStartError extends Error {
  constructor(message, { code, exitCode = null, signal = null, tail = [], command = '' } = {}) {
    super(message);
    this.name = 'BackendStartError';
    this.code = code;
    this.exitCode = exitCode;
    this.signal = signal;
    this.tail = tail;
    this.command = command;
  }
}

function openLog(logFile) {
  if (!logFile) return null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      /* no previous log */
    }
    return fs.createWriteStream(logFile, { flags: 'a' });
  } catch {
    return null;
  }
}

class BackendManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.host]
   * @param {boolean} [opts.isPackaged]
   * @param {string} [opts.resourcesPath]  process.resourcesPath (packaged)
   * @param {string} [opts.repoRoot]       repository root (dev)
   * @param {string} [opts.dataDir]        writable dir for the DB / cwd of packaged backend
   * @param {string} [opts.logFile]        backend stdout/stderr go here
   * @param {object} [opts.env]
   * @param {string} [opts.platform]
   * @param {string} [opts.token]          defaults to a random 48-hex token
   * @param {number} [opts.readyTimeoutMs] default 60 s (first run may load the ASR model)
   * @param {number} [opts.healthIntervalMs]
   * @param {number} [opts.stopTimeoutMs]
   */
  constructor(opts = {}) {
    super();
    this.opts = {
      host: '127.0.0.1',
      isPackaged: false,
      env: process.env,
      platform: process.platform,
      readyTimeoutMs: 60_000,
      healthIntervalMs: 400,
      stopTimeoutMs: 5000,
      portRetries: 2,
      ...opts,
    };
    this.token = this.opts.token || generateToken();
    this.state = 'idle'; // idle | starting | ready | stopping | stopped | crashed | failed
    this.child = null;
    this.port = null;
    this.url = null;
    this.readyVia = null;
    this.tail = [];
    this._starting = null;
    this._stopping = null;
    this._log = null;
  }

  get pid() {
    return this.child ? this.child.pid : null;
  }

  get logFile() {
    return this.opts.logFile || null;
  }

  info() {
    return { url: this.url, port: this.port, token: this.token, pid: this.pid, readyVia: this.readyVia };
  }

  /** Starts the backend (idempotent: concurrent calls share one start). */
  start() {
    if (this.state === 'ready' && this.child) return Promise.resolve(this.info());
    if (this._starting) return this._starting;
    const run = async () => {
      if (this._stopping) await this._stopping;
      let lastErr = null;
      for (let attempt = 0; attempt <= this.opts.portRetries; attempt++) {
        try {
          return await this._startOnce();
        } catch (err) {
          lastErr = err;
          const portClash = err.code === 'exited' && PORT_IN_USE_RE.test(err.tail.join('\n'));
          if (!portClash) break;
          this._write('desktop', `port ${this.port} is busy, retrying with another port`);
        }
      }
      this.state = 'failed';
      throw lastErr;
    };
    this._starting = run().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  _write(stream, line) {
    const text = redact(line, this.token);
    this.tail.push(`[${stream}] ${text}`);
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES);
    if (!this._log) this._log = openLog(this.opts.logFile);
    if (this._log) this._log.write(`${new Date().toISOString()} [${stream}] ${text}\n`);
    this.emit('log', { stream, line: text });
  }

  tailText(n = 40) {
    return this.tail.slice(-n).join('\n');
  }

  async _startOnce() {
    const { host } = this.opts;
    this.state = 'starting';
    this.readyVia = null;
    this.port = await findFreePort(host);
    this.url = `http://${host}:${this.port}`;
    const cmd = buildBackendCommand({
      host,
      port: this.port,
      token: this.token,
      env: this.opts.env,
      platform: this.opts.platform,
      isPackaged: this.opts.isPackaged,
      resourcesPath: this.opts.resourcesPath,
      repoRoot: this.opts.repoRoot,
      workDir: this.opts.workDir,
    });
    const env = buildBackendEnv({ baseEnv: this.opts.env, token: this.token, dataDir: this.opts.dataDir });
    const printable = describeCommand(cmd, this.token);
    this._write('desktop', `starting backend (${cmd.kind}): ${printable} (cwd=${cmd.cwd || process.cwd()})`);

    if (cmd.kind === 'packaged' && !fs.existsSync(cmd.command)) {
      throw new BackendStartError(`Не найден встроенный движок: ${cmd.command}`, {
        code: 'missing_binary', command: printable, tail: this.tail.slice(-40),
      });
    }
    if (cmd.cwd) fs.mkdirSync(cmd.cwd, { recursive: true });

    const posix = this.opts.platform !== 'win32';
    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so stop() can kill the whole tree.
      detached: posix,
    });
    this.child = child;
    // stdin stays open for the backend's lifetime; a backend that watches for
    // EOF on stdin exits by itself if the desktop app dies without cleanup.
    child.stdin.on('error', () => {});

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let poller = null;

      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        clearTimeout(poller);
      };
      const markReady = (via) => {
        if (settled) return;
        cleanup();
        this.state = 'ready';
        this.readyVia = via;
        this._write('desktop', `backend ready at ${this.url} (via ${via}, pid ${child.pid})`);
        const info = this.info();
        this.emit('ready', info);
        resolve(info);
      };
      const fail = (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      };

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        this._write('stdout', line);
        const origin = parseReadyLine(line);
        if (origin) {
          if (origin !== this.url) this._write('desktop', `warning: READY line says ${origin}, expected ${this.url}`);
          markReady('ready-line');
        }
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => this._write('stderr', line));

      child.once('error', (err) => {
        this._write('desktop', `spawn error: ${err.message}`);
        const hint = cmd.kind === 'dev'
          ? ` Установите Python 3.10+ и зависимости (pip install -e .) или укажите интерпретатор в RECAPPER_PYTHON.`
          : '';
        fail(new BackendStartError(`Не удалось запустить движок (${cmd.command}): ${err.message}.${hint}`, {
          code: 'spawn_failed', command: printable, tail: this.tail.slice(-40),
        }));
        if (this.child === child) this.child = null;
      });

      child.once('exit', (code, signal) => {
        this._write('desktop', `backend exited (code=${code}, signal=${signal})`);
        const wasReady = this.state === 'ready' && settled;
        if (this.child === child) this.child = null;
        const expected = Boolean(this._stopping) || this.state === 'stopping';
        if (!settled) {
          fail(new BackendStartError(`Движок завершился при запуске (код ${code ?? signal}).`, {
            code: 'exited', exitCode: code, signal, command: printable, tail: this.tail.slice(-40),
          }));
          return;
        }
        if (!wasReady && !expected) return; // killed after a failed start: already reported
        if (!expected) this.state = 'crashed';
        this.emit('exit', { code, signal, expected });
      });

      timer = setTimeout(() => {
        const secs = Math.round(this.opts.readyTimeoutMs / 1000);
        this._write('desktop', `backend not ready after ${secs}s, killing it`);
        fail(new BackendStartError(`Движок не ответил за ${secs} с.`, {
          code: 'timeout', command: printable, tail: this.tail.slice(-40),
        }));
        this._kill(child).catch(() => {});
      }, this.opts.readyTimeoutMs);

      // Fallback when the READY line is missing (e.g. buffered stdout).
      const poll = async () => {
        if (settled) return;
        if (await probeHealth(this.url, Math.min(1500, this.opts.healthIntervalMs * 4))) {
          if (!settled && this.child === child) markReady('health');
          return;
        }
        if (!settled) poller = setTimeout(poll, this.opts.healthIntervalMs);
      };
      poller = setTimeout(poll, this.opts.healthIntervalMs);
    });
  }

  /** Stops the backend (idempotent). Resolves once the process has exited. */
  stop() {
    if (this._stopping) return this._stopping;
    const child = this.child;
    if (!child) {
      if (this.state !== 'failed') this.state = 'stopped';
      return Promise.resolve();
    }
    this.state = 'stopping';
    this._stopping = this._kill(child)
      .then(() => {
        this.state = 'stopped';
        if (this.child === child) this.child = null;
      })
      .finally(() => {
        this._stopping = null;
      });
    return this._stopping;
  }

  _kill(child) {
    const { stopTimeoutMs, platform } = this.opts;
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hard);
        resolve();
      };
      child.once('exit', finish);
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      if (platform === 'win32') {
        // Kill the tree: venv python.exe and `py` are launchers with a child.
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
          if (err) {
            try { child.kill(); } catch { /* ignore */ }
          }
        });
      } else {
        this._signal(child, 'SIGTERM');
      }
      const hard = setTimeout(() => {
        this._write('desktop', `backend did not exit in ${stopTimeoutMs} ms, sending SIGKILL`);
        this._signal(child, 'SIGKILL');
        setTimeout(finish, 2000);
      }, stopTimeoutMs);
    });
  }

  _signal(child, sig) {
    if (this.opts.platform === 'win32') {
      try { child.kill(); } catch { /* ignore */ }
      return;
    }
    try {
      process.kill(-child.pid, sig); // whole process group
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  }

  /** Synchronous last-resort kill (process 'exit' handler). */
  killSync() {
    const child = this.child;
    if (!child) return;
    if (this.opts.platform === 'win32') {
      try { child.kill(); } catch { /* ignore */ }
    } else {
      this._signal(child, 'SIGKILL');
    }
  }

  close() {
    if (this._log) {
      this._log.end();
      this._log = null;
    }
  }
}

module.exports = { BackendManager, BackendStartError, PORT_IN_USE_RE };
