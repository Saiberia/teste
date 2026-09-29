"""Minimal stand-in for `python -m recapper serve` used by the desktop tests.

Implements the desktop <-> backend contract with the standard library only:

  serve --host H --port P --token T
  stdout: "RECAPPER_READY http://H:P" once listening
  GET  /api/health                      (no auth)
  GET  /?token=...[&view=panel]         test page that loads /static/capture.js
  GET  /static/capture.js               the REAL recapper/web/static/capture.js
  GET  /api/settings, PUT /api/settings
  POST /api/live                        -> {"id", "mode"}
  POST /api/live/{sid}/audio            multipart file/source/offset -> canned segment
  GET  /api/live/{sid}/events?since=N
  POST /api/live/{sid}/finish
  GET  /__test__/chunks, /__test__/info  (auth) inspection endpoints for tests

Test knobs (environment):
  FAKE_NO_READY_LINE=1   do not print the READY line (health-poll fallback)
  FAKE_EXIT_CODE=N       print to stderr and exit with N before listening
  FAKE_FAIL_ONCE_FILE=f  fail (exit 4) only if file f does not exist yet (creates it)
  FAKE_HANG=1            never listen (readiness timeout)
  FAKE_READY_DELAY=S     sleep S seconds before listening
  FAKE_RECORD_DIR=dir    also save received WAV chunks there
  FAKE_ASR_UNAVAILABLE=1 audio endpoint answers 503
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
CAPTURE_JS = HERE.parents[2] / "recapper" / "web" / "static" / "capture.js"

DEFAULT_SETTINGS = {
    "ui_language": "ru",
    "capture_chunk_seconds": 12,
    "capture_sources": ["mic", "system"],
    "capture_silence_threshold": 0.004,
    "panel_hotkey": "CommandOrControl+Shift+R",
    "panel_always_on_top": True,
    "panel_hide_from_screen_share": True,
    "theme": "system",
}

PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Recapper (fake)</title></head>
<body>
<h1 id="view">__VIEW__</h1>
<button id="start">Начать запись</button>
<button id="stop">Стоп</button>
<button id="panel">Панель</button>
<pre id="log"></pre>
<script src="/static/capture.js"></script>
<script>
const q = new URLSearchParams(location.search);
if (q.get('token')) sessionStorage.setItem('recapper_token', q.get('token'));
const token = sessionStorage.getItem('recapper_token') || '';
const T = window.__test = { view: __VIEW_JSON__, statuses: [], errors: [], results: [], sid: null, startInfo: null, startError: null };
const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(r.status + ' ' + await r.text());
  return r.json();
}
T.api = api;
T.startCapture = async (extra = {}) => {
  const live = await api('/api/live', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'E2E', template: 'default', auto_answer: 'commands' }) });
  T.sid = live.id;
  try {
    T.startInfo = await RecapperCapture.start({
      sessionId: live.id, token, ...extra,
      onStatus: (msg, d) => { T.statuses.push({ msg, ...d }); log('status: ' + d.state + ' ' + d.code + ' ' + msg); },
      onError: (e) => { T.errors.push({ message: e.message, status: e.status, code: e.code, fatal: e.fatal, source: e.source }); log('error: ' + e.message); },
      onResult: (body, meta) => { T.results.push({ body, meta }); log('result: ' + meta.source + ' #' + meta.seq); },
    });
  } catch (e) {
    T.startError = e.message;
    log('start failed: ' + e.message);
  }
  return T.startInfo;
};
document.getElementById('start').onclick = () => {
  const chunk = Number(q.get('chunk') || 0) || undefined;
  T.startCapture({ ...(chunk ? { chunkSeconds: chunk } : {}), ...(window.__captureOptions || {}) });
};
document.getElementById('stop').onclick = () => RecapperCapture.stop();
document.getElementById('panel').onclick = () => window.recapperDesktop && window.recapperDesktop.togglePanel();
</script>
</body></html>
"""


class State:
    def __init__(self, token: str, record_dir: Path | None):
        self.token = token
        self.record_dir = record_dir
        self.lock = threading.Lock()
        self.sessions: dict[str, dict] = {}
        self.chunks: list[dict] = []
        self.settings = dict(DEFAULT_SETTINGS)
        self.counter = 0


def parse_wav(data: bytes) -> dict:
    info: dict = {"bytes": len(data), "riff": data[:4] == b"RIFF" and data[8:12] == b"WAVE"}
    if len(data) < 44 or not info["riff"]:
        return info
    fmt_tag, channels, rate, byte_rate, align, bits = struct.unpack("<HHIIHH", data[20:36])
    info.update(
        fmt_tag=fmt_tag, channels=channels, sample_rate=rate, byte_rate=byte_rate, block_align=align,
        bits=bits, data_tag=data[36:40].decode("latin-1"), data_len=struct.unpack("<I", data[40:44])[0],
        riff_size=struct.unpack("<I", data[4:8])[0],
    )
    samples = data[44:]
    n = len(samples) // 2
    if n:
        vals = struct.unpack(f"<{n}h", samples[: n * 2])
        info["rms"] = math.sqrt(sum(v * v for v in vals) / n) / 32768.0
        info["peak"] = max(abs(v) for v in vals) / 32768.0
        info["duration"] = n / rate if rate else 0
    return info


def parse_multipart(body: bytes, content_type: str) -> dict[str, tuple[dict, bytes]]:
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):].strip('"')
    if not boundary:
        raise ValueError("no boundary")
    fields: dict[str, tuple[dict, bytes]] = {}
    for chunk in body.split(b"--" + boundary.encode()):
        if not chunk or chunk in (b"--\r\n", b"--"):
            continue
        chunk = chunk[2:] if chunk.startswith(b"\r\n") else chunk
        head, _, value = chunk.partition(b"\r\n\r\n")
        if value.endswith(b"\r\n"):
            value = value[:-2]
        headers = {}
        for line in head.decode("utf-8", "replace").split("\r\n"):
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        disp = headers.get("content-disposition", "")
        params = {}
        for item in disp.split(";")[1:]:
            k, _, v = item.strip().partition("=")
            params[k] = v.strip('"')
        if "name" in params:
            fields[params["name"]] = (params, value)
    return fields


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = "FakeRecapper/1.0"

        def log_message(self, fmt, *args):  # stderr -> desktop backend.log
            sys.stderr.write("fake-backend: " + (fmt % args).replace(state.token, "***") + "\n")

        # -- helpers --
        def _json(self, code: int, obj) -> None:
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authed(self) -> bool:
            if self.headers.get("authorization", "") == f"Bearer {state.token}":
                return True
            self._json(401, {"detail": "invalid token"})
            return False

        def _body(self) -> bytes:
            n = int(self.headers.get("content-length") or 0)
            return self.rfile.read(n) if n else b""

        # -- routes --
        def do_GET(self):  # noqa: N802
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path == "/api/health":
                return self._json(200, {"status": "ok", "mode": "fake", "asr": "fake"})
            if url.path == "/":
                view = (q.get("view") or ["main"])[0]
                page = PAGE.replace("__VIEW_JSON__", json.dumps(view)).replace("__VIEW__", "panel" if view == "panel" else "main")
                data = page.encode()
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return None
            if url.path == "/static/capture.js":
                data = CAPTURE_JS.read_bytes()
                self.send_response(200)
                self.send_header("content-type", "application/javascript; charset=utf-8")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return None
            if not self._authed():
                return None
            if url.path == "/api/settings":
                return self._json(200, {"values": state.settings, "schema": []})
            if url.path == "/__test__/chunks":
                with state.lock:
                    return self._json(200, {"chunks": state.chunks})
            if url.path == "/__test__/info":
                return self._json(200, {"pid": os.getpid(), "ppid": os.getppid(), "argv": sys.argv[1:],
                                        "env_token": os.environ.get("RECAPPER_API_TOKEN") == state.token,
                                        "cwd": os.getcwd(), "data_dir": os.environ.get("RECAPPER_DATA_DIR", "")})
            parts = url.path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "live"] and parts[3] == "events":
                sess = state.sessions.get(parts[2])
                if not sess:
                    return self._json(404, {"detail": "сессия не найдена"})
                since = int((q.get("since") or ["0"])[0])
                events = [e for e in sess["events"] if e["seq"] > since]
                return self._json(200, {"events": events, "last": events[-1]["seq"] if events else since,
                                        "finished": sess["finished"]})
            return self._json(404, {"detail": "not found"})

        def do_PUT(self):  # noqa: N802
            if not self._authed():
                return None
            if urlparse(self.path).path == "/api/settings":
                body = json.loads(self._body() or b"{}")
                state.settings.update(body.get("values") or {})
                return self._json(200, {"values": state.settings, "schema": []})
            return self._json(404, {"detail": "not found"})

        def do_POST(self):  # noqa: N802
            if not self._authed():
                return None
            url = urlparse(self.path)
            parts = url.path.strip("/").split("/")
            if url.path == "/api/live":
                body = json.loads(self._body() or b"{}")
                with state.lock:
                    state.counter += 1
                    sid = f"sid{state.counter}"
                    state.sessions[sid] = {"title": body.get("title"), "request": body, "events": [], "finished": False, "seq": 0}
                return self._json(200, {"id": sid, "mode": "fake"})
            if len(parts) == 4 and parts[:2] == ["api", "live"]:
                sess = state.sessions.get(parts[2])
                if not sess:
                    return self._json(404, {"detail": "сессия не найдена"})
                if parts[3] == "finish":
                    sess["finished"] = True
                    return self._json(200, {"report": {"id": parts[2]}, "markdown": "# E2E"})
                if parts[3] == "audio":
                    if sess["finished"]:
                        return self._json(409, {"detail": "сессия завершена"})
                    if os.environ.get("FAKE_ASR_UNAVAILABLE") == "1":
                        return self._json(503, {"detail": "ASR не настроен"})
                    fields = parse_multipart(self._body(), self.headers.get("content-type", ""))
                    file_params, wav = fields.get("file", ({}, b""))
                    source = fields.get("source", ({}, b""))[1].decode()
                    offset = float(fields.get("offset", ({}, b"0"))[1] or 0)
                    info = parse_wav(wav)
                    info.update(source=source, offset=offset, filename=file_params.get("filename"),
                                seq=fields.get("seq", ({}, b""))[1].decode(), session=parts[2],
                                received_at=time.time())
                    with state.lock:
                        state.chunks.append(info)
                        n = len(state.chunks)
                        sess["seq"] += 1
                        seg = {"text": f"тестовый сегмент {n}", "start": offset,
                               "end": offset + info.get("duration", 0), "speaker": "Я" if source == "mic" else "Собеседник",
                               "source": source}
                        sess["events"].append({"seq": sess["seq"], "type": "segment", "data": seg})
                    if state.record_dir:
                        state.record_dir.mkdir(parents=True, exist_ok=True)
                        (state.record_dir / f"{n:03d}-{source}.wav").write_bytes(wav)
                    return self._json(200, {"added": 1, "segments": [seg], "new_items": []})
            return self._json(404, {"detail": "not found"})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(prog="fake_backend")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, required=True)
    s.add_argument("--token", required=True)
    args = parser.parse_args()

    print(f"fake backend starting pid={os.getpid()}", file=sys.stderr, flush=True)
    marker = os.environ.get("FAKE_FAIL_ONCE_FILE")
    if marker and not os.path.exists(marker):
        Path(marker).write_text("failed once")
        print("fatal: simulated first-start failure", file=sys.stderr, flush=True)
        return 4
    if os.environ.get("FAKE_EXIT_CODE"):
        print("fatal: simulated startup failure", file=sys.stderr, flush=True)
        return int(os.environ["FAKE_EXIT_CODE"])
    if os.environ.get("FAKE_HANG") == "1":
        while True:
            time.sleep(1)
    delay = float(os.environ.get("FAKE_READY_DELAY") or 0)
    if delay:
        time.sleep(delay)

    record = os.environ.get("FAKE_RECORD_DIR")
    state = State(args.token, Path(record) if record else None)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    server.daemon_threads = True

    # Exit if the desktop app disappears (stdin closed), like the real sidecar should.
    def watch_stdin():
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:
            pass
        server.shutdown()

    if os.environ.get("RECAPPER_DESKTOP") == "1":
        threading.Thread(target=watch_stdin, daemon=True).start()

    if os.environ.get("FAKE_NO_READY_LINE") != "1":
        print(f"RECAPPER_READY http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
