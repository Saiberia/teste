"""HTTP API + small web UI.

Batch:  POST /api/meetings (transcript text/file), POST /api/meetings/audio
Live:   POST /api/live -> segments -> events (poll) -> finish
The live endpoints are also the integration point for a desktop capture app.
"""

from __future__ import annotations

import secrets
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

from ..asr import ASRError, Transcriber, get_transcriber
from ..config import Settings
from ..engine import Components, LiveSession, build_components, process_segments
from ..models import MeetingReport, Segment
from ..render import report_to_markdown
from ..store import ReportStore
from ..transcript import parse_transcript

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024
MAX_LIVE_SESSIONS = 50
LIVE_TTL_SECONDS = 6 * 3600


class LiveCreate(BaseModel):
    title: str = "Встреча"


class LiveSegments(BaseModel):
    segments: list[Segment] = Field(default_factory=list)
    text: str = ""  # alternative: raw transcript lines
    flush: bool = False


class LiveAsk(BaseModel):
    question: str = Field(min_length=2, max_length=2000)


def _questions(raw: str) -> list[str]:
    return [q.strip() for q in raw.splitlines() if q.strip()]


def create_app(
    settings: Settings | None = None,
    components_factory: Callable[[str], Components] | None = None,
    store: ReportStore | None = None,
    transcriber: Transcriber | None = None,
    api_token: str | None = None,
) -> FastAPI:
    import os

    settings = settings or Settings.from_env()
    store = store or ReportStore(settings.db_path, keep_segments=settings.store_segments)
    token = api_token if api_token is not None else os.environ.get("RECAPPER_API_TOKEN", "")
    factory = components_factory or (lambda title: build_components(settings, title=title))
    probe = factory("probe")
    mode = probe.mode
    _asr: dict[str, Transcriber | None] = {"t": transcriber}
    live: dict[str, tuple[LiveSession, float]] = {}
    live_lock = threading.Lock()

    def asr() -> Transcriber:
        if _asr["t"] is None:
            try:
                _asr["t"] = get_transcriber(settings)
            except ASRError as exc:
                raise HTTPException(503, str(exc)) from exc
        if _asr["t"] is None:
            raise HTTPException(503, "Распознавание речи не настроено (RECAPPER_ASR=faster-whisper)")
        return _asr["t"]

    def auth(authorization: str = Header(default="")) -> None:
        if token and not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "invalid token")

    app = FastAPI(title="Recapper", version="0.1.0")

    def run(segments: list[Segment], title: str, questions: list[str]) -> MeetingReport:
        report = process_segments(segments, factory(title), title=title, questions=questions)
        store.save(report)
        return report

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "mode": mode, "asr": settings.asr_provider, "auth": bool(token)}

    @app.post("/api/meetings", dependencies=[Depends(auth)])
    async def create_meeting(
        title: str = Form("Встреча"),
        transcript: str = Form(""),
        questions: str = Form(""),
        file: UploadFile | None = File(None),
    ) -> dict:
        text = transcript
        if file is not None and file.filename:
            raw = await file.read(MAX_TRANSCRIPT_BYTES + 1)
            if len(raw) > MAX_TRANSCRIPT_BYTES:
                raise HTTPException(413, "файл расшифровки слишком большой")
            text = raw.decode("utf-8", errors="replace")
        segments = parse_transcript(text)
        if not segments:
            raise HTTPException(422, "пустая или нераспознанная расшифровка")
        from starlette.concurrency import run_in_threadpool

        report = await run_in_threadpool(run, segments, title, _questions(questions))
        return {"report": report.model_dump(mode="json"), "markdown": report_to_markdown(report)}

    @app.post("/api/meetings/audio", dependencies=[Depends(auth)])
    async def create_meeting_audio(
        file: UploadFile = File(...),
        consent: bool = Form(False),
        title: str = Form("Встреча"),
        questions: str = Form(""),
    ) -> dict:
        if not consent:
            raise HTTPException(400, "Подтвердите, что участники согласились на запись (consent=true)")
        transcriber = asr()
        suffix = Path(file.filename or "audio").suffix[:10]
        from starlette.concurrency import run_in_threadpool

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "аудиофайл слишком большой")
                tmp.write(chunk)
            tmp.flush()
            try:
                segments = await run_in_threadpool(transcriber.transcribe, Path(tmp.name))
            except ASRError as exc:
                raise HTTPException(422, str(exc)) from exc
        # The audio file is deleted here: only text is kept.
        if not segments:
            raise HTTPException(422, "в аудио не распознано речи")
        report = await run_in_threadpool(run, segments, title, _questions(questions))
        return {"report": report.model_dump(mode="json"), "markdown": report_to_markdown(report)}

    @app.get("/api/meetings", dependencies=[Depends(auth)])
    def list_meetings() -> list[dict]:
        return store.list()

    @app.get("/api/meetings/{report_id}", dependencies=[Depends(auth)])
    def get_meeting(report_id: str) -> dict:
        report = store.get(report_id)
        if report is None:
            raise HTTPException(404, "не найдено")
        return report.model_dump(mode="json")

    @app.get("/api/meetings/{report_id}/markdown", dependencies=[Depends(auth)], response_class=PlainTextResponse)
    def get_markdown(report_id: str) -> str:
        report = store.get(report_id)
        if report is None:
            raise HTTPException(404, "не найдено")
        return report_to_markdown(report)

    @app.delete("/api/meetings/{report_id}", dependencies=[Depends(auth)])
    def delete_meeting(report_id: str) -> dict:
        if not store.delete(report_id):
            raise HTTPException(404, "не найдено")
        return {"deleted": report_id}

    # --- live ---------------------------------------------------------
    def _gc() -> None:
        now = time.time()
        for sid, (sess, created) in list(live.items()):
            if now - created > LIVE_TTL_SECONDS:
                sess.close()
                live.pop(sid, None)

    def _session(sid: str) -> LiveSession:
        with live_lock:
            entry = live.get(sid)
        if entry is None:
            raise HTTPException(404, "сессия не найдена")
        return entry[0]

    @app.post("/api/live", dependencies=[Depends(auth)])
    def live_create(body: LiveCreate) -> dict:
        with live_lock:
            _gc()
            if len(live) >= MAX_LIVE_SESSIONS:
                raise HTTPException(429, "слишком много активных сессий")
            sess = LiveSession(factory(body.title), title=body.title)
            live[sess.report.id] = (sess, time.time())
        return {"id": sess.report.id, "mode": sess.report.mode}

    @app.post("/api/live/{sid}/segments", dependencies=[Depends(auth)])
    def live_segments(sid: str, body: LiveSegments) -> dict:
        sess = _session(sid)
        segments = list(body.segments) + parse_transcript(body.text)
        if not segments and not body.flush:
            raise HTTPException(422, "нет реплик")
        try:
            items = sess.add_segments(segments, flush=body.flush)
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"added": len(segments), "new_items": [i.model_dump(mode="json") for i in items]}

    @app.post("/api/live/{sid}/ask", dependencies=[Depends(auth)])
    def live_ask(sid: str, body: LiveAsk) -> dict:
        sess = _session(sid)
        if sess.finished:
            raise HTTPException(409, "сессия завершена")
        return sess.ask(body.question).model_dump(mode="json")

    @app.get("/api/live/{sid}/events", dependencies=[Depends(auth)])
    def live_events(sid: str, since: int = 0) -> dict:
        sess = _session(sid)
        events = sess.events(since)
        return {
            "events": [{"seq": e.seq, "type": e.type, "data": e.data} for e in events],
            "last": events[-1].seq if events else since,
            "finished": sess.finished,
        }

    @app.post("/api/live/{sid}/finish", dependencies=[Depends(auth)])
    def live_finish(sid: str) -> dict:
        sess = _session(sid)
        report = sess.finish()
        store.save(report)
        with live_lock:
            live.pop(sid, None)
        return {"report": report.model_dump(mode="json"), "markdown": report_to_markdown(report)}

    return app


def main() -> None:
    import uvicorn

    uvicorn.run("recapper.web.app:create_app", factory=True, host="127.0.0.1", port=8000)
