#!/usr/bin/env python3
"""Build the Recapper backend sidecar with PyInstaller and smoke-test it.

    pip install -e ".[asr]" pyinstaller
    python packaging/build_server.py

Output: dist/recapper-server/recapper-server[.exe] (one-folder build), which the
desktop app bundles as <resources>/backend (see desktop/package.json → extraResources).

Works the same on macOS, Windows and Linux (no shell specifics). PyInstaller
cannot cross-compile: build on each target OS/arch (CI: native runners).

Smoke test (default on): runs `recapper-server --help`, then `serve` with a random
token and checks /api/health, /api/settings (auth), /static/capture.js and that
faster-whisper is importable inside the frozen app. With --smoke-asr-model tiny
it also downloads that Whisper model and transcribes a short WAV through
POST /api/live/{sid}/audio (needs internet access to huggingface.co).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "packaging" / "recapper_server.spec"
IS_WIN = sys.platform == "win32"
EXE_NAME = "recapper-server.exe" if IS_WIN else "recapper-server"


def log(msg: str) -> None:
    print(f"[build_server] {msg}", flush=True)


def fail(msg: str) -> NoReturn:
    print(f"[build_server] ERROR: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def have(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def build(dist: Path, work: Path, clean: bool) -> Path:
    if not have("PyInstaller"):
        fail("PyInstaller is not installed: pip install pyinstaller")
    if not (ROOT / "recapper" / "__main__.py").is_file():
        fail(f"backend sources not found in {ROOT / 'recapper'}")
    missing = [m for m in ("fastapi", "uvicorn", "pydantic", "anthropic", "multipart") if not have(m)]
    if missing:
        fail(f'backend dependencies are missing ({", ".join(missing)}): pip install -e ".[asr]" (from the repository root)')
    out = dist / "recapper-server"
    if clean and out.exists():
        shutil.rmtree(out)
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--distpath", str(dist), "--workpath", str(work)]
    if clean:
        cmd.append("--clean")
    cmd.append(str(SPEC))
    log("running: " + " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)
    exe = out / EXE_NAME
    if not exe.is_file():
        fail(f"build finished but {exe} is missing")
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    log(f"built {exe} ({size / 1e6:.0f} MB in {out})")
    return exe


# ------------------------------------------------------------------ smoke test ---
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method: str, url: str, token: str | None = None, body: bytes | None = None,
         content_type: str | None = None, timeout: float = 30) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback: never via a proxy
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def tone_wav(seconds: float = 2.0, rate: int = 16000) -> bytes:
    n = int(seconds * rate)
    pcm = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(n))
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


def multipart(fields: dict[str, str], file_bytes: bytes) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.wav"\r\n'
                 f"Content-Type: audio/wav\r\n\r\n".encode() + file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def smoke(exe: Path, asr_model: str | None, timeout: float) -> None:
    log("smoke: --help")
    r = subprocess.run([str(exe), "--help"], capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or "serve" not in r.stdout:
        fail(f"`{exe.name} --help` failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")

    port, token = free_port(), secrets.token_hex(24)
    data_dir = Path(tempfile.mkdtemp(prefix="recapper-smoke-"))
    env = {**os.environ, "RECAPPER_DATA_DIR": str(data_dir), "RECAPPER_LLM": "sim-good", "PYTHONUNBUFFERED": "1"}
    env.pop("RECAPPER_ASR", None)  # let `serve` auto-detect the bundled faster-whisper
    if asr_model:
        env["RECAPPER_WHISPER_MODEL"] = asr_model
    cmd = [str(exe), "serve", "--host", "127.0.0.1", "--port", str(port), "--token", token]
    log(f"smoke: {exe.name} serve --port {port} --token *** (data dir {data_dir})")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
                            encoding="utf-8", errors="replace")
    lines: list[str] = []
    ready = threading.Event()

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line.rstrip())
            if line.startswith("RECAPPER_READY"):
                ready.set()

    threading.Thread(target=pump, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        if not ready.wait(timeout):
            fail(f"no RECAPPER_READY within {timeout:.0f}s; output:\n" + "\n".join(lines[-40:]))
        status, body = http("GET", f"{base}/api/health")
        health = json.loads(body)
        log(f"smoke: /api/health -> {status} {health}")
        if status != 200 or health.get("status") != "ok":
            fail("health check failed")
        if http("GET", f"{base}/api/settings")[0] != 401:
            fail("/api/settings must require the token")
        status, body = http("GET", f"{base}/api/settings", token)
        if status != 200 or "values" not in json.loads(body):
            fail(f"/api/settings -> {status}")
        status, body = http("GET", f"{base}/static/capture.js")
        if status != 200 or b"RecapperCapture" not in body:
            fail(f"/static/capture.js -> {status}: static files are not bundled")
        if have("faster_whisper"):
            if health.get("asr") != "faster-whisper":
                fail(f"faster-whisper was installed at build time but is not importable in the frozen app "
                     f"(health.asr={health.get('asr')!r}, asr_error={health.get('asr_error')!r})")
            log("smoke: faster-whisper import works inside the bundle")
        if asr_model:
            status, body = http("POST", f"{base}/api/live", token, json.dumps({"title": "smoke"}).encode(),
                                "application/json")
            sid = json.loads(body)["id"]
            payload, ctype = multipart({"source": "mic", "offset": "0"}, tone_wav())
            log(f"smoke: transcribing a test WAV with model {asr_model!r} (first run downloads it)")
            status, body = http("POST", f"{base}/api/live/{sid}/audio", token, payload, ctype, timeout=900)
            if status != 200:
                fail(f"/api/live/{{sid}}/audio -> {status}: {body[:500]!r}")
            log(f"smoke: ASR ok: {json.loads(body)}")
        log("smoke: OK")
    finally:
        proc.terminate()
        try:
            proc.wait(15)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(data_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dist", type=Path, default=ROOT / "dist", help="output dir (default: <repo>/dist)")
    ap.add_argument("--work", type=Path, default=ROOT / "build" / "pyinstaller", help="PyInstaller work dir")
    ap.add_argument("--no-clean", action="store_true", help="reuse the previous build cache")
    ap.add_argument("--skip-build", action="store_true", help="only run the smoke test on an existing build")
    ap.add_argument("--no-smoke", action="store_true", help="do not run the smoke test")
    ap.add_argument("--require-asr", action="store_true", help="fail if faster-whisper is not installed (CI)")
    ap.add_argument("--smoke-asr-model", default=None,
                    help="also transcribe a test WAV with this Whisper model, e.g. tiny (downloads it)")
    ap.add_argument("--smoke-timeout", type=float, default=120, help="seconds to wait for RECAPPER_READY")
    args = ap.parse_args(argv)

    if args.require_asr and not have("faster_whisper"):
        fail('faster-whisper is not installed: pip install -e ".[asr]"')
    exe = args.dist / "recapper-server" / EXE_NAME
    if not args.skip_build:
        exe = build(args.dist.resolve(), args.work.resolve(), clean=not args.no_clean)
    elif not exe.is_file():
        fail(f"{exe} does not exist")
    if not args.no_smoke:
        smoke(exe, args.smoke_asr_model, args.smoke_timeout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
