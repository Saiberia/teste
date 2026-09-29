'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectBinary, checkBackend } = require('../../scripts/check-backend');

function elf(machine) {
  const b = Buffer.alloc(64);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = 2; // 64-bit
  b[5] = 1; // little endian
  b.writeUInt16LE(machine, 18);
  return b;
}
function pe(machine) {
  const b = Buffer.alloc(256);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(machine, 0x84);
  return b;
}
function macho(cpu) {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}
function fat(cpus) {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((c, i) => b.writeUInt32BE(c, 8 + i * 20));
  return b;
}

test('detectBinary recognises ELF / PE / Mach-O and the CPU', () => {
  assert.deepEqual(detectBinary(elf(0x3e)), { os: 'linux', arch: 'x64' });
  assert.deepEqual(detectBinary(elf(0xb7)), { os: 'linux', arch: 'arm64' });
  assert.deepEqual(detectBinary(pe(0x8664)), { os: 'win32', arch: 'x64' });
  assert.deepEqual(detectBinary(pe(0xaa64)), { os: 'win32', arch: 'arm64' });
  assert.deepEqual(detectBinary(macho(0x0100000c)), { os: 'darwin', arch: 'arm64' });
  assert.deepEqual(detectBinary(macho(0x01000007)), { os: 'darwin', arch: 'x64' });
  assert.deepEqual(detectBinary(fat([0x01000007, 0x0100000c])), { os: 'darwin', arch: 'universal', archs: ['x64', 'arm64'] });
  assert.deepEqual(detectBinary(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(64))), { os: 'unknown', arch: 'unknown' });
  assert.deepEqual(detectBinary(Buffer.alloc(3)), { os: 'unknown', arch: 'unknown' });
});

test('checkBackend: missing, wrong OS, wrong arch, ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recapper-backend-check-'));
  assert.throws(() => checkBackend({ platform: 'darwin', arch: 'arm64', dir }), /not found.*build_server\.py/s);
  fs.writeFileSync(path.join(dir, 'recapper-server'), elf(0x3e));
  assert.throws(() => checkBackend({ platform: 'darwin', arch: 'arm64', dir }), /linux binary.*cannot cross-compile/);
  fs.writeFileSync(path.join(dir, 'recapper-server'), macho(0x01000007));
  assert.throws(() => checkBackend({ platform: 'darwin', arch: 'arm64', dir }), /built for x64.*target arch is arm64/);
  assert.equal(checkBackend({ platform: 'darwin', arch: 'x64', dir }).arch, 'x64');
  assert.throws(() => checkBackend({ platform: 'darwin', arch: 'universal', dir }), /universal/);
  fs.writeFileSync(path.join(dir, 'recapper-server.exe'), pe(0x8664));
  assert.equal(checkBackend({ platform: 'win32', arch: 'x64', dir }).os, 'win32');
  fs.rmSync(dir, { recursive: true, force: true });
});

const REAL_EXE = path.resolve(__dirname, '..', '..', '..', 'dist', 'recapper-server', 'recapper-server');
const noRealExe = process.platform !== 'linux' || !fs.existsSync(REAL_EXE) ? 'no Linux sidecar built in ../dist' : false;

test('the real Linux sidecar is recognised', { skip: noRealExe }, () => {
  const exe = REAL_EXE;
  const head = fs.readFileSync(exe).subarray(0, 4096);
  assert.equal(detectBinary(head).os, 'linux');
  assert.equal(detectBinary(head).arch, process.arch === 'arm64' ? 'arm64' : 'x64');
});
