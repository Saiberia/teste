"""The real Recapper server with a fake speech recognizer, for the extension e2e test.

Everything is the production code path (create_app, live sessions, events, the
``sim-good`` simulated AI); only the transcriber is replaced. It checks that
every uploaded chunk is a RIFF/WAVE, 16 kHz, mono, 16-bit PCM file (via the
``wave`` module) and "recognises" a fixed voice command in it.

For assertions the test can read ``GET /__test__/uploads``: every
``POST /api/live/{sid}/audio`` seen (session, source, offset, HTTP status) and
the WAV parameters the transcriber validated. This only observes requests.

Usage:
    python fake_asr_server.py --port 8798 --token exttoken --data-dir DIR [--chunk-seconds 4]
Prints ``RECAPPER_READY http://127.0.0.1:<port>`` once it accepts connections.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from recapper.asr import ASRError  # noqa: E402
from recapper.config import Settings  # noqa: E402
from recapper.models import Segment  # noqa: E402
from recapper.web.app import create_app  # noqa: E402

COMMAND = "Ассистент, посчитай бюджет на награды для игры."
AUDIO_PATH = re.compile(r"^/api/live/([^/]+)/audio$")


class FakeTranscriber:
    """Validates the WAV format like a strict ASR front-end would, returns a fixed command."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.lock = threading.Lock()

    def transcribe(self, path: Path) -> list[Segment]:
        head = Path(path).read_bytes()[:12]
        try:
            with wave.open(str(path), "rb") as w:
                info = {"channels": w.getnchannels(), "rate": w.getframerate(), "width": w.getsampwidth(),
                        "frames": w.getnframes(), "compression": w.getcomptype()}
        except (wave.Error, EOFError) as exc:
            with self.lock:
                self.calls.append({"ok": False, "error": str(exc)})
            raise ASRError(f"не WAV-файл: {exc}") from exc
        ok = (head[:4] == b"RIFF" and head[8:12] == b"WAVE" and info["rate"] == 16000 and info["channels"] == 1
              and info["width"] == 2 and info["compression"] == "NONE" and info["frames"] > 0)
        info["duration"] = round(info["frames"] / info["rate"], 3) if info["rate"] else 0
        with self.lock:
            self.calls.append({**info, "ok": ok})
        if not ok:
            raise ASRError(f"ожидается WAV 16 кГц, моно, 16 бит; получено {info}")
        return [Segment(text=COMMAND, start=0.0, end=2.0)]


class UploadRecorder:
    """ASGI middleware: records audio uploads and serves them at /__test__/uploads."""

    def __init__(self, app, transcriber: FakeTranscriber) -> None:
        self.app = app
        self.transcriber = transcriber
        self.uploads: list[dict] = []
        self.lock = threading.Lock()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == "/__test__/uploads":
            with self.lock, self.transcriber.lock:
                body = json.dumps({"uploads": self.uploads, "transcriber": self.transcriber.calls}).encode()
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": body})
            return None
        match = AUDIO_PATH.match(scope["path"])
        if scope["method"] != "POST" or not match:
            return await self.app(scope, receive, send)

        parts = []
        while True:
            message = await receive()
            parts.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        body = b"".join(parts)
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        status = {}

        async def watch(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        await self.app(scope, replay, watch)
        field = lambda name: (re.search(rb'name="' + name + rb'"\r\n\r\n([^\r]*)\r\n', body) or [None, b""])[1]
        with self.lock:
            self.uploads.append({
                "session": match.group(1),
                "source": field(b"source").decode(errors="replace"),
                "offset": field(b"offset").decode(errors="replace"),
                "bytes": len(body),
                "status": status.get("code"),
                "at": time.time(),
            })
        return None


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8798)
    ap.add_argument("--token", default="exttoken")
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--chunk-seconds", type=int, default=4)
    ap.add_argument("--ui-language", default="ru")
    args = ap.parse_args()

    data = Path(args.data_dir)
    data.mkdir(parents=True, exist_ok=True)
    settings = Settings(db_path=data / "recapper.db", llm_provider="sim-good", knowledge_dir=data / "knowledge",
                        asr_provider="fake-wav-check", capture_chunk_seconds=args.chunk_seconds,
                        ui_language=args.ui_language)
    transcriber = FakeTranscriber()
    app = UploadRecorder(create_app(settings, transcriber=transcriber, api_token=args.token), transcriber)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning"))

    def announce() -> None:
        while not server.started and not server.should_exit:
            time.sleep(0.05)
        if server.started:
            print(f"RECAPPER_READY http://127.0.0.1:{args.port}", flush=True)

    threading.Thread(target=announce, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
