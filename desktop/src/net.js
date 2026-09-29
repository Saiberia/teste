'use strict';
// Small networking helpers (Node core only, no Electron).

const http = require('node:http');
const net = require('node:net');

/** Asks the OS for a free TCP port on `host`. */
function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * HTTP request to the local backend; resolves `{status, json, text}`.
 * Uses node:http directly (no proxy env handling: the backend is on loopback).
 */
function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:') {
      reject(new Error(`unsupported protocol ${u.protocol}`));
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms: ${method} ${u.pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** One health probe: true when GET /api/health answers 200 with status ok. */
async function probeHealth(baseUrl, timeoutMs = 1500) {
  try {
    const r = await requestJson(new URL('/api/health', baseUrl).toString(), { timeoutMs });
    return r.status === 200 && r.json && r.json.status === 'ok';
  } catch {
    return false;
  }
}

module.exports = { findFreePort, requestJson, probeHealth };
