'use strict';
// electron-builder `beforePack` hook: refuse to build an installer without the
// PyInstaller backend (../dist/recapper-server), or with one built for another
// OS / CPU architecture (PyInstaller cannot cross-compile).
// Escape hatch for UI-only experiments: RECAPPER_ALLOW_NO_BACKEND=1.

const fs = require('node:fs');
const path = require('node:path');

const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'dist', 'recapper-server');

// builder-util Arch enum
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

/** Identifies an executable's format and CPU from its first bytes. */
function detectBinary(buf) {
  if (!buf || buf.length < 64) return { os: 'unknown', arch: 'unknown' };
  // ELF
  if (buf[0] === 0x7f && buf.toString('latin1', 1, 4) === 'ELF') {
    const little = buf[5] === 1;
    const machine = little ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    return { os: 'linux', arch: { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'armv7l' }[machine] || `elf-${machine}` };
  }
  // PE (MZ header -> PE\0\0 -> machine)
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 6 <= buf.length && buf.toString('latin1', peOff, peOff + 4) === 'PE\0\0') {
      const machine = buf.readUInt16LE(peOff + 4);
      return { os: 'win32', arch: { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[machine] || `pe-${machine}` };
    }
    return { os: 'win32', arch: 'unknown' };
  }
  // Mach-O (thin, little-endian 64-bit) or universal (fat, big-endian)
  const magicLE = buf.readUInt32LE(0);
  const cpu = { 0x01000007: 'x64', 0x0100000c: 'arm64' };
  if (magicLE === 0xfeedfacf) return { os: 'darwin', arch: cpu[buf.readUInt32LE(4)] || 'unknown' };
  if (buf.readUInt32BE(0) === 0xcafebabe) {
    const n = buf.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < n && 8 + i * 20 + 4 <= buf.length; i++) archs.push(cpu[buf.readUInt32BE(8 + i * 20)] || 'unknown');
    return { os: 'darwin', arch: archs.length > 1 ? 'universal' : archs[0] || 'unknown', archs };
  }
  return { os: 'unknown', arch: 'unknown' };
}

/** Throws a readable error when the backend does not fit the target. */
function checkBackend({ platform, arch, dir = BACKEND_DIR }) {
  const exe = path.join(dir, platform === 'win32' ? 'recapper-server.exe' : 'recapper-server');
  if (!fs.existsSync(exe)) {
    throw new Error(
      `Backend sidecar not found: ${exe}\n` +
      'Build it first on this OS: python packaging/build_server.py (see packaging/README.md), ' +
      'or set RECAPPER_ALLOW_NO_BACKEND=1 to package without it.',
    );
  }
  const fd = fs.openSync(exe, 'r');
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const found = detectBinary(head);
  if (found.os !== platform) {
    throw new Error(`Backend ${exe} is a ${found.os} binary, but the target platform is ${platform}. PyInstaller cannot cross-compile: build the backend on ${platform}.`);
  }
  const archOk = arch === 'universal'
    ? found.arch === 'universal' && found.archs.includes('x64') && found.archs.includes('arm64')
    : found.arch === arch || (found.arch === 'universal' && (found.archs || []).includes(arch));
  if (!archOk) {
    throw new Error(`Backend ${exe} is built for ${found.arch}, but the target arch is ${arch}. Build the backend on a ${arch} machine (or runner).`);
  }
  return { exe, ...found };
}

exports.detectBinary = detectBinary;
exports.checkBackend = checkBackend;
exports.default = async function beforePack(context) {
  if (process.env.RECAPPER_ALLOW_NO_BACKEND === '1') {
    console.warn('  • RECAPPER_ALLOW_NO_BACKEND=1: packaging WITHOUT the backend sidecar');
    return;
  }
  const arch = ARCH_NAMES[context.arch] || String(context.arch);
  const r = checkBackend({ platform: context.electronPlatformName, arch });
  console.log(`  • backend sidecar ok  file=${r.exe} os=${r.os} arch=${r.arch}`);
};
