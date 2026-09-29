'use strict';
// Pure helpers that decide how the Python backend is launched.
// No Electron imports: unit-tested with `node --test`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER_RE = /\{(host|port|token)\}/g;

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function defaultPython(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

/**
 * Python interpreter for dev mode: $RECAPPER_PYTHON, then a repo-local .venv,
 * then python3 (python on Windows).
 */
function resolvePython({ env = process.env, platform = process.platform, repoRoot, exists = fs.existsSync } = {}) {
  if (env.RECAPPER_PYTHON && env.RECAPPER_PYTHON.trim()) return env.RECAPPER_PYTHON.trim();
  if (repoRoot) {
    const venv = platform === 'win32'
      ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(repoRoot, '.venv', 'bin', 'python');
    if (exists(venv)) return venv;
  }
  return defaultPython(platform);
}

/**
 * Splits a command string like a POSIX shell would for simple cases:
 * whitespace separates words, single/double quotes group, backslash escapes
 * inside double quotes and outside quotes (but not before a Windows path
 * separator, so `C:\Python\python.exe` survives).
 */
function splitCommand(str) {
  const out = [];
  let cur = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && (str[i + 1] === '"' || str[i + 1] === '\\')) cur += str[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (/\s/.test(c)) {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
      continue;
    }
    if (c === '\\' && i + 1 < str.length && /[\s'"]/.test(str[i + 1])) { cur += str[++i]; inWord = true; continue; }
    cur += c;
    inWord = true;
  }
  if (quote) throw new Error(`RECAPPER_BACKEND_CMD: незакрытая кавычка в «${str}»`);
  if (inWord) out.push(cur);
  return out;
}

/** RECAPPER_BACKEND_CMD: a JSON array (`["python3","fake.py"]`) or a command string. */
function parseCommandOverride(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let argv;
  if (s.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      throw new Error(`RECAPPER_BACKEND_CMD: некорректный JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string' || typeof x === 'number')) {
      throw new Error('RECAPPER_BACKEND_CMD: ожидается JSON-массив строк');
    }
    argv = parsed.map(String);
  } else {
    argv = splitCommand(s);
  }
  if (!argv.length || !argv[0]) throw new Error('RECAPPER_BACKEND_CMD: пустая команда');
  return argv;
}

function serverBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'recapper-server.exe' : 'recapper-server';
}

function packagedServerPath(resourcesPath, platform = process.platform) {
  return path.join(resourcesPath, 'backend', serverBinaryName(platform));
}

/**
 * Builds the backend command.
 *
 * - RECAPPER_BACKEND_CMD set: that command. If it contains {host}/{port}/{token}
 *   placeholders they are substituted and nothing is appended; otherwise
 *   `serve --host H --port P --token T` is appended.
 * - packaged app: <resources>/backend/recapper-server[.exe] serve ...
 * - dev: <python> -m recapper serve ... with cwd = repo root.
 *
 * @returns {{command: string, args: string[], cwd: string|undefined, kind: 'override'|'packaged'|'dev'}}
 */
function buildBackendCommand({
  host = '127.0.0.1',
  port,
  token,
  env = process.env,
  platform = process.platform,
  isPackaged = false,
  resourcesPath,
  repoRoot,
  workDir,
  exists = fs.existsSync,
}) {
  if (!port) throw new Error('port is required');
  if (!token) throw new Error('token is required');
  const serveArgs = ['serve', '--host', host, '--port', String(port), '--token', token];

  const override = parseCommandOverride(env.RECAPPER_BACKEND_CMD);
  if (override) {
    const hasPlaceholders = override.some((a) => /\{(host|port|token)\}/.test(a));
    const values = { host, port: String(port), token };
    const argv = hasPlaceholders
      ? override.map((a) => a.replace(PLACEHOLDER_RE, (_, k) => values[k]))
      : [...override, ...serveArgs];
    return { command: argv[0], args: argv.slice(1), cwd: workDir || repoRoot, kind: 'override' };
  }

  if (isPackaged) {
    if (!resourcesPath) throw new Error('resourcesPath is required for a packaged app');
    return {
      command: packagedServerPath(resourcesPath, platform),
      args: serveArgs,
      cwd: workDir || path.join(resourcesPath, 'backend'),
      kind: 'packaged',
    };
  }

  const python = resolvePython({ env, platform, repoRoot, exists });
  return { command: python, args: ['-m', 'recapper', ...serveArgs], cwd: repoRoot, kind: 'dev' };
}

/** Environment for the backend process. User-provided values win. */
function buildBackendEnv({ baseEnv = process.env, token, dataDir, parentPid = process.pid } = {}) {
  const env = { ...baseEnv };
  env.PYTHONUNBUFFERED = '1'; // the READY line must not sit in a pipe buffer
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.RECAPPER_DESKTOP = '1';
  env.RECAPPER_PARENT_PID = String(parentPid);
  if (token) env.RECAPPER_API_TOKEN = token;
  // The backend keeps its DB, settings and knowledge files in RECAPPER_DATA_DIR
  // (default ~/.recapper, shared with the CLI). Only set when explicitly chosen.
  if (dataDir && !baseEnv.RECAPPER_DATA_DIR) env.RECAPPER_DATA_DIR = dataDir;
  // Never leak the test/automation switches of the desktop shell into Python.
  delete env.RECAPPER_BACKEND_CMD;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Replaces the token in a string (for logs and error messages). */
function redact(text, token) {
  if (!token) return String(text);
  return String(text).split(token).join('***');
}

/** Human-readable command line with the token redacted. */
function describeCommand({ command, args }, token) {
  const q = (a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
  return redact([command, ...args].map(q).join(' '), token);
}

module.exports = {
  generateToken,
  defaultPython,
  resolvePython,
  splitCommand,
  parseCommandOverride,
  serverBinaryName,
  packagedServerPath,
  buildBackendCommand,
  buildBackendEnv,
  redact,
  describeCommand,
};
