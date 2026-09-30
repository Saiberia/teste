"""HTTP API + web UI (also used inside the desktop app).

Everything a meeting produces goes through a live session, so batch uploads,
live audio and typed questions share one event stream:
    POST /api/live | /api/meetings | /api/meetings/audio  -> session id
    GET  /api/live/{sid}/events?since=N                    -> items, answers, assist, recap, done
"""

from __future__ import annotations

import logging
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import __version__
from ..answer import knowledge_context, memory_context
from ..asr import ASRError, Transcriber, get_transcriber
from ..assist import ASSIST_ACTIONS, TEMPLATES
from ..config import Settings
from ..engine import LiveSession, Runtime, SessionClosed
from ..knowledge import TEXT_SUFFIXES
from ..models import ActionItem, Item, ItemKind, ItemOrigin, MeetingReport, Segment
from ..prefs import PrefsStore, SettingsError, apply_prefs, public_values, schema, validate_update
from ..llm import LLMError
from ..providers import OpenAICompatLLM, TracingLLM, normalize_base_url
from ..render import report_to_docx, report_to_markdown
from ..store import ReportStore
from ..transcript import parse_transcript

log = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
OWNER = "web"  # the web/desktop app is single-user; the bot uses "tg:<id>"
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024
MAX_KB_FILE_BYTES = 2 * 1024 * 1024
MAX_LIVE_SESSIONS = 20
LIVE_IDLE_TTL = 3 * 3600  # seconds without activity before an open session is dropped
DONE_TTL = 600  # finished sessions stay queryable this long
MAX_SEGMENTS_PER_REQUEST = 500
MAX_SESSION_SEGMENTS = 20_000


class LiveCreate(BaseModel):
    title: str = Field("Встреча", max_length=200)
    template: str | None = Field(None, max_length=40)
    auto_answer: str | None = Field(None, pattern="^(commands|all)$")
    consent: bool = False


class ItemStatus(BaseModel):
    status: str = Field(pattern="^(active|cancelled|dismissed)$")


class ActionItemIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    owner: str = Field("", max_length=100)
    due: str = Field("", max_length=100)
    done: bool = False


class RecapPatch(BaseModel):
    summary: str | None = Field(None, max_length=20_000)
    decisions: list[str] | None = Field(None, max_length=200)
    action_items: list[ActionItemIn] | None = Field(None, max_length=200)


class MeetingPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    reviewed: bool | None = None
    recap: RecapPatch | None = None


class Rebuild(BaseModel):
    template: str = Field(max_length=40)


class LiveSegments(BaseModel):
    segments: list[Segment] = Field(default_factory=list, max_length=MAX_SEGMENTS_PER_REQUEST)
    text: str = Field("", max_length=100_000)  # alternative: raw transcript lines
    flush: bool = False


class Question(BaseModel):
    question: str = Field(min_length=2, max_length=2000)


class AssistRequest(BaseModel):
    action: str
    minutes: float = Field(1.0, ge=0.25, le=30)


class SpeakerRename(BaseModel):
    old: str = Field(min_length=1, max_length=100)
    new: str = Field(min_length=1, max_length=100)


class AITest(BaseModel):
    """Unsaved form values; empty fields fall back to the saved settings."""
    base_url: str = ""
    api_key: str = ""
    model: str = ""


class SettingsUpdate(BaseModel):
    values: dict[str, Any]


def _questions(raw: str) -> list[str]:
    return [q.strip()[:2000] for q in raw.splitlines() if q.strip()][:20]


def default_data_dir() -> Path:
    import os

    return Path(os.environ.get("RECAPPER_DATA_DIR") or Path.home() / ".recapper")


def create_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    transcriber: Transcriber | None = None,
    api_token: str | None = None,
    allow_no_auth: bool | None = None,
) -> FastAPI:
    import os

    base = settings or Settings.from_env()
    prefs = PrefsStore(base.db_path)
    effective = apply_prefs(base, prefs.load())
    if effective.knowledge_dir is None:
        effective.knowledge_dir = Path(base.db_path).parent / "knowledge"
    if runtime is None:
        runtime = Runtime(effective, ReportStore(effective.db_path, keep_segments=effective.store_segments))
    else:
        runtime.apply_settings(effective)
    store = runtime.store
    store.purge_older_than(effective.retention_days)

    token = api_token if api_token is not None else os.environ.get("RECAPPER_API_TOKEN", "")
    if allow_no_auth is None:
        allow_no_auth = os.environ.get("RECAPPER_ALLOW_NO_AUTH", "") == "1"
    if not token and not allow_no_auth:
        token = secrets.token_urlsafe(24)
        log.warning("RECAPPER_API_TOKEN is not set; generated a one-time token: %s", token)

    state: dict[str, Any] = {"asr": transcriber, "asr_error": ""}
    asr_lock = threading.Lock()
    live: dict[str, LiveSession] = {}
    done_at: dict[str, float] = {}
    live_lock = threading.Lock()

    def settings_now() -> Settings:
        return runtime.settings

    def asr() -> Transcriber:
        with asr_lock:  # the model is loaded once, never concurrently
            if state["asr"] is None:
                try:
                    state["asr"] = get_transcriber(settings_now())
                except ASRError as exc:
                    state["asr_error"] = str(exc)
                    raise HTTPException(503, str(exc)) from exc
            if state["asr"] is None:
                raise HTTPException(503, "Распознавание речи выключено в настройках")
            return state["asr"]

    def auth(authorization: str = Header(default="")) -> None:
        if token and not secrets.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            raise HTTPException(401, "invalid token")

    app = FastAPI(title="Recapper", version=__version__)
    app.state.runtime = runtime
    app.state.token = token
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.exception_handler(SessionClosed)
    async def _closed(_: Request, exc: SessionClosed) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    # --- pages & meta ------------------------------------------------------
    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/api/health")
    def health() -> dict:
        s = settings_now()
        return {"status": "ok", "version": __version__, "mode": runtime.mode, "llm_error": runtime.llm_error,
                "asr": s.asr_provider, "asr_error": state["asr_error"], "auth": bool(token)}

    @app.get("/api/meta", dependencies=[Depends(auth)])
    def meta() -> dict:
        return {
            "templates": [{"id": t.id, "name": t.name, "sections": list(t.sections)} for t in TEMPLATES.values()],
            "assist_actions": [{"id": k, "title": v} for k, v in ASSIST_ACTIONS.items()],
        }

    @app.get("/api/settings", dependencies=[Depends(auth)])
    def get_settings() -> dict:
        return {"values": public_values(settings_now()), "schema": schema()}

    @app.put("/api/settings", dependencies=[Depends(auth)])
    def put_settings(body: SettingsUpdate) -> dict:
        try:
            clean = validate_update(body.values)
        except SettingsError as exc:
            raise HTTPException(422, str(exc)) from exc
        prefs.save(clean)
        new = apply_prefs(base, prefs.load())
        new.knowledge_dir = settings_now().knowledge_dir
        old = settings_now()
        runtime.apply_settings(new)
        store.keep_segments = new.store_segments
        if (old.asr_provider, old.whisper_model, old.meeting_language) != (new.asr_provider, new.whisper_model,
                                                                            new.meeting_language):
            with asr_lock:
                if transcriber is None:
                    state["asr"], state["asr_error"] = None, ""
        store.purge_older_than(new.retention_days)
        return {"values": public_values(new), "mode": runtime.mode, "llm_error": runtime.llm_error}

    @app.post("/api/ai/test", dependencies=[Depends(auth)])
    def ai_test(body: AITest) -> dict:
        """Check an OpenAI-compatible server: list its models, then send a one-word request."""
        s = settings_now()
        base_url = normalize_base_url(body.base_url or s.openai_base_url)
        if not base_url.startswith(("http://", "https://")):
            raise HTTPException(422, "укажите адрес сервера, начиная с http:// или https://")
        llm = OpenAICompatLLM(base_url, body.api_key or s.openai_api_key, body.model or s.openai_model, timeout=30)
        out: dict[str, Any] = {"base_url": base_url, "models": [], "models_error": "", "reply": "", "error": ""}
        try:
            out["models"] = llm.list_models()
        except LLMError as exc:
            out["models_error"] = str(exc)
        model = body.model or s.openai_model
        if out["models"] and model not in out["models"]:
            out["error"] = f"модели «{model}» нет на сервере — выберите из списка"
        else:
            try:
                out["reply"] = llm.ping()[:200]
            except LLMError as exc:
                out["error"] = str(exc)
        out["ok"] = not out["error"]
        return out

    # --- sessions ------------------------------------------------------------
    def _gc() -> None:
        now = time.monotonic()
        with live_lock:
            for sid, sess in list(live.items()):
                idle = now - sess.last_activity > LIVE_IDLE_TTL and sess.state == "open"
                expired = sid in done_at and now - done_at[sid] > DONE_TTL
                if idle or expired:
                    sess.close()
                    live.pop(sid, None)
                    done_at.pop(sid, None)

    def _new_session(title: str, template: str | None, auto_answer: str | None) -> LiveSession:
        if template and template not in TEMPLATES:
            raise HTTPException(422, f"неизвестный шаблон: {template}")
        _gc()
        with live_lock:
            if sum(1 for s in live.values() if s.state == "open") >= MAX_LIVE_SESSIONS:
                raise HTTPException(429, "слишком много активных сессий")
            sess = runtime.session(title, OWNER, template=template, auto_answer=auto_answer)
            live[sess.report.id] = sess
        return sess

    def _session(sid: str) -> LiveSession:
        _gc()
        with live_lock:
            sess = live.get(sid)
        if sess is None:
            raise HTTPException(404, "сессия не найдена")
        return sess

    def _finish_in_background(sess: LiveSession) -> None:
        def run() -> None:
            try:
                sess.finish(before_done=lambda report: store.save(report, owner=OWNER))  # saved before "done"
            except Exception:  # never lose the session silently
                log.exception("finish failed")
                sess._emit("error", {"message": "не удалось завершить встречу", "retry": False})
            finally:
                with live_lock:
                    done_at[sess.report.id] = time.monotonic()

        threading.Thread(target=run, name=f"finish-{sess.report.id}", daemon=True).start()

    def _run_batch(sess: LiveSession, segments: list[Segment], questions: list[str]) -> None:
        def run() -> None:
            try:
                from ..engine import _chunks

                for chunk in _chunks(segments):
                    sess.add_segments(chunk, flush=True)
                for q in questions:
                    sess.ask(q)
            except Exception as exc:
                log.exception("batch processing failed")
                sess._emit("error", {"message": f"обработка: {exc}", "retry": False})
            _finish_in_background(sess)

        threading.Thread(target=run, name=f"batch-{sess.report.id}", daemon=True).start()

    @app.get("/api/live", dependencies=[Depends(auth)])
    def live_list() -> list[dict]:
        """Open sessions, newest first (the floating panel attaches to the first one)."""
        _gc()
        with live_lock:  # dict order = creation order; newest first
            sessions = [s for s in reversed(list(live.values())) if s.state != "finished"]
        return [{"id": s.report.id, "title": s.report.title, "state": s.state, "created_at": s.report.created_at,
                 "template": s.report.template} for s in sessions]

    @app.post("/api/live", dependencies=[Depends(auth)])
    def live_create(body: LiveCreate) -> dict:
        sess = _new_session(body.title, body.template, body.auto_answer)
        sess.report.consent_noted = body.consent
        return {"id": sess.report.id, "mode": sess.report.mode, "template": sess.report.template}

    @app.post("/api/live/{sid}/segments", dependencies=[Depends(auth)])
    def live_segments(sid: str, body: LiveSegments) -> dict:
        sess = _session(sid)
        segments = list(body.segments) + parse_transcript(body.text)
        if not segments and not body.flush:
            raise HTTPException(422, "нет реплик")
        if len(sess.report.segments) + len(segments) > MAX_SESSION_SEGMENTS:
            raise HTTPException(413, "слишком длинная сессия")
        items = sess.add_segments(segments, flush=body.flush)
        return {"added": len(segments), "new_items": [i.model_dump(mode="json") for i in items]}

    @app.post("/api/live/{sid}/audio", dependencies=[Depends(auth)])
    async def live_audio(sid: str, file: UploadFile = File(...), source: str = Form("mic"),
                         offset: float = Form(0.0)) -> dict:
        sess = _session(sid)
        if sess.state != "open":
            raise HTTPException(409, "сессия завершена")
        if source not in ("mic", "system"):
            raise HTTPException(422, "source: mic или system")
        transcriber = await run_in_threadpool(asr)
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "фрагмент слишком большой")
        s = settings_now()
        speaker = s.me_label if source == "mic" else s.others_label

        def transcribe() -> list[Segment]:
            with tempfile.TemporaryDirectory() as tmp:  # audio is deleted right after recognition
                path = Path(tmp) / "chunk.wav"
                path.write_bytes(data)
                return transcriber.transcribe(path)

        try:
            raw = await run_in_threadpool(transcribe)
        except ASRError as exc:
            raise HTTPException(422, str(exc)) from exc
        segments = [Segment(speaker=speaker, text=seg.text, start=(seg.start or 0.0) + max(offset, 0.0),
                            end=(seg.end + max(offset, 0.0)) if seg.end is not None else None) for seg in raw]
        items = await run_in_threadpool(sess.add_segments, segments) if segments else []
        return {"added": len(segments), "segments": [x.model_dump(mode="json") for x in segments],
                "new_items": [i.model_dump(mode="json") for i in items]}

    @app.post("/api/live/{sid}/ask", dependencies=[Depends(auth)])
    def live_ask(sid: str, body: Question) -> dict:
        return _session(sid).ask(body.question).model_dump(mode="json")

    @app.post("/api/live/{sid}/items/{item_id}/answer", dependencies=[Depends(auth)])
    def live_answer_item(sid: str, item_id: str) -> dict:
        try:
            return _session(sid).request_answer(item_id).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(404, "пункт не найден") from exc

    @app.post("/api/live/{sid}/items/{item_id}/status", dependencies=[Depends(auth)])
    def live_item_status(sid: str, item_id: str, body: ItemStatus) -> dict:
        try:
            return _session(sid).set_item_status(item_id, body.status).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(404, "пункт не найден") from exc

    @app.post("/api/live/{sid}/items/{item_id}/refine", dependencies=[Depends(auth)])
    def live_refine(sid: str, item_id: str, body: Question) -> dict:
        try:
            return _session(sid).refine(item_id, body.question).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(404, "пункт не найден") from exc

    @app.post("/api/live/{sid}/assist", dependencies=[Depends(auth)])
    def live_assist(sid: str, body: AssistRequest) -> dict:
        if body.action not in ASSIST_ACTIONS:
            raise HTTPException(422, f"неизвестное действие: {body.action}")
        return _session(sid).assist(body.action, body.minutes)

    @app.get("/api/live/{sid}/events", dependencies=[Depends(auth)])
    def live_events(sid: str, since: int = Query(0, ge=0)) -> dict:
        sess = _session(sid)
        events = sess.events(since)
        return {
            "events": [{"seq": e.seq, "type": e.type, "data": e.data} for e in events],
            "last": events[-1].seq if events else since,
            "state": sess.state,
            "finished": sess.finished,
        }

    @app.get("/api/live/{sid}", dependencies=[Depends(auth)])
    def live_state(sid: str) -> dict:
        sess = _session(sid)
        return {"state": sess.state, "report": sess.report.model_dump(mode="json")}

    @app.post("/api/live/{sid}/finish", dependencies=[Depends(auth)])
    def live_finish(sid: str) -> dict:
        sess = _session(sid)
        if sess.state == "open":
            _finish_in_background(sess)
        return {"id": sid, "state": "closing" if sess.state != "finished" else "finished"}

    # --- batch input (runs as a session in the background) -----------------------
    @app.post("/api/meetings", dependencies=[Depends(auth)])
    async def create_meeting(request: Request) -> dict:
        """Form fields: title, transcript (text) or file, questions, template, auto_answer."""
        try:  # parsed by hand: Starlette's default 1 MB per-field limit is below our transcript limit
            # x3: urlencoded Cyrillic grows threefold; the decoded size is checked below.
            form = await request.form(max_part_size=MAX_TRANSCRIPT_BYTES * 3 + 1024)
        except Exception as exc:
            raise HTTPException(413, f"форма слишком большая: {exc}") from exc
        field = lambda name: form.get(name) if isinstance(form.get(name), str) else ""  # noqa: E731
        title = field("title") or "Встреча"
        if len(title) > 200:
            raise HTTPException(422, "title: не длиннее 200 символов")
        text = field("transcript")
        upload = form.get("file")
        if upload is not None and not isinstance(upload, str) and upload.filename:
            raw = await upload.read(MAX_TRANSCRIPT_BYTES + 1)
            if len(raw) > MAX_TRANSCRIPT_BYTES:
                raise HTTPException(413, "файл расшифровки слишком большой")
            text = raw.decode("utf-8", errors="replace")
        if len(text.encode()) > MAX_TRANSCRIPT_BYTES:
            raise HTTPException(413, "расшифровка слишком большая")
        segments = parse_transcript(text)
        if not segments:
            raise HTTPException(422, "пустая или нераспознанная расшифровка")
        auto_answer = field("auto_answer")
        sess = _new_session(title, field("template") or None, auto_answer if auto_answer in ("commands", "all") else None)
        _run_batch(sess, segments, _questions(field("questions")))
        return {"id": sess.report.id, "state": "processing"}

    @app.post("/api/meetings/audio", dependencies=[Depends(auth)])
    async def create_meeting_audio(
        file: UploadFile = File(...),
        consent: bool = Form(False),
        title: str = Form("Встреча", max_length=200),
        questions: str = Form(""),
        template: str = Form(""),
    ) -> dict:
        if not consent:
            raise HTTPException(400, "Подтвердите, что участники согласились на запись (consent=true)")
        transcriber = await run_in_threadpool(asr)
        suffix = re.sub(r"[^.\w]", "", Path(file.filename or "audio").suffix)[:10]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"upload{suffix}"
            size = 0
            with path.open("wb") as out:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "аудиофайл слишком большой")
                    out.write(chunk)
            try:
                segments = await run_in_threadpool(transcriber.transcribe, path)
            except ASRError as exc:
                raise HTTPException(422, str(exc)) from exc
        # The audio file is deleted here: only text is kept.
        if not segments:
            raise HTTPException(422, "в аудио не распознано речи")
        sess = _new_session(title, template or None, None)
        _run_batch(sess, segments, _questions(questions))
        return {"id": sess.report.id, "state": "processing"}

    # --- stored reports ---------------------------------------------------------------
    def _report(report_id: str) -> MeetingReport:
        report = store.get(report_id, owner=OWNER)
        if report is None:
            raise HTTPException(404, "не найдено")
        return report

    @app.get("/api/meetings", dependencies=[Depends(auth)])
    def list_meetings(limit: int = Query(100, ge=1, le=500)) -> list[dict]:
        return store.list(owner=OWNER, limit=limit)

    @app.get("/api/meetings/{report_id}", dependencies=[Depends(auth)])
    def get_meeting(report_id: str) -> dict:
        return _report(report_id).model_dump(mode="json")

    @app.get("/api/meetings/{report_id}/markdown", dependencies=[Depends(auth)], response_class=PlainTextResponse)
    def get_markdown(report_id: str) -> str:
        return report_to_markdown(_report(report_id), settings_now().ui_language)

    @app.get("/api/meetings/{report_id}/docx", dependencies=[Depends(auth)])
    def get_docx(report_id: str) -> Response:
        report = _report(report_id)
        data = report_to_docx(report, settings_now().ui_language)
        return Response(data, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        headers={"Content-Disposition": f'attachment; filename="recapper-{report.id}.docx"'})

    @app.delete("/api/meetings/{report_id}", dependencies=[Depends(auth)])
    def delete_meeting(report_id: str) -> dict:
        if not store.delete(report_id, owner=OWNER):
            raise HTTPException(404, "не найдено")
        return {"deleted": report_id}

    @app.patch("/api/meetings/{report_id}", dependencies=[Depends(auth)])
    def patch_meeting(report_id: str, body: MeetingPatch) -> dict:
        """Edit the report in place: title, "всё проверено", summary, decisions, action items checklist."""
        report = _report(report_id)
        if body.title is not None:
            report.title = body.title
        if body.reviewed is not None:
            report.reviewed = body.reviewed
        if body.recap is not None:
            if body.recap.summary is not None:
                report.recap.summary = body.recap.summary
            if body.recap.decisions is not None:
                report.recap.decisions = [d.strip() for d in body.recap.decisions if d.strip()]
            if body.recap.action_items is not None:
                report.recap.action_items = [ActionItem(**a.model_dump()) for a in body.recap.action_items]
        store.save(report, owner=OWNER)
        return report.model_dump(mode="json")

    @app.post("/api/meetings/{report_id}/rebuild", dependencies=[Depends(auth)])
    def rebuild(report_id: str, body: Rebuild) -> dict:
        """Rebuild the summary with another report template (answers are kept)."""
        if body.template not in TEMPLATES:
            raise HTTPException(422, f"неизвестный шаблон: {body.template}")
        report = _report(report_id)
        if not report.segments:
            raise HTTPException(409, "расшифровка не хранится — пересобрать нельзя")
        components = runtime.components(report.title, OWNER, exclude_id=report.id, template=body.template)
        report.recap = components.recapper.recap(report.segments)
        report.template = body.template
        report.reviewed = False
        store.save(report, owner=OWNER)
        return report.model_dump(mode="json")

    @app.post("/api/meetings/{report_id}/items/{item_id}/status", dependencies=[Depends(auth)])
    def stored_item_status(report_id: str, item_id: str, body: ItemStatus) -> dict:
        report = _report(report_id)
        item = report.item(item_id)
        if item is None:
            raise HTTPException(404, "пункт не найден")
        item.status = body.status
        store.save(report, owner=OWNER)
        return item.model_dump(mode="json")

    @app.post("/api/meetings/{report_id}/speakers", dependencies=[Depends(auth)])
    def rename_speaker(report_id: str, body: SpeakerRename) -> dict:
        report = _report(report_id)
        count = report.rename_speaker(body.old, body.new)
        if not count:
            raise HTTPException(404, "такого спикера нет")
        store.save(report, owner=OWNER)
        return {"renamed": count}

    @app.post("/api/meetings/{report_id}/items/{item_id}/answer", dependencies=[Depends(auth)])
    def answer_stored_item(report_id: str, item_id: str) -> dict:
        report = _report(report_id)
        item = report.item(item_id)
        if item is None:
            raise HTTPException(404, "пункт не найден")
        components = runtime.components(report.title, OWNER, exclude_id=report.id, template=report.template)
        answer = components.answerer.answer(item, report.segments)
        report.answers = [a for a in report.answers if a.item_id != item_id] + [answer]
        store.save(report, owner=OWNER)
        return answer.model_dump(mode="json")

    @app.post("/api/meetings/{report_id}/chat", dependencies=[Depends(auth)])
    def chat(report_id: str, body: Question) -> dict:
        report = _report(report_id)
        components = runtime.components(report.title, OWNER, exclude_id=report.id)
        past, _ = memory_context(runtime.memory(OWNER, exclude_id=report.id)(body.question))
        probe = Item(kind=ItemKind.QUESTION, text=body.question, origin=ItemOrigin.USER)
        docs, _ = knowledge_context(probe, runtime.kb, k=3)
        return components.assistant.chat(body.question, report, past=past, docs=docs)

    # --- memory across meetings ----------------------------------------------------
    @app.get("/api/memory/search", dependencies=[Depends(auth)])
    def memory_search(q: str = Query(..., min_length=2, max_length=500)) -> list[dict]:
        hits = runtime.memory(OWNER)(q)
        return [{"meeting_id": h.meeting_id, "title": h.title, "date": h.date, "text": h.text, "score": round(h.score, 3)}
                for h in hits]

    @app.post("/api/ask", dependencies=[Depends(auth)])
    def ask_all_meetings(body: Question) -> dict:
        """A question about all meetings at once ("что мы решили про атрибуцию?")."""
        components = runtime.components("Все встречи", OWNER)
        past, sources = memory_context(runtime.memory(OWNER)(body.question))
        probe = Item(kind=ItemKind.QUESTION, text=body.question, origin=ItemOrigin.USER)
        docs, _ = knowledge_context(probe, runtime.kb, k=3)
        result = components.assistant.chat(body.question, MeetingReport(title="Все встречи"), past=past, docs=docs)
        return {**result, "sources": [s.model_dump() for s in sources]}

    # --- knowledge base ------------------------------------------------------------------
    def _kb_dir() -> Path:
        path = Path(settings_now().knowledge_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path

    @app.get("/api/knowledge", dependencies=[Depends(auth)])
    def list_knowledge() -> list[dict]:
        return [{"name": f.name, "size": f.stat().st_size} for f in sorted(_kb_dir().iterdir())
                if f.is_file() and f.suffix.lower() in TEXT_SUFFIXES]

    @app.post("/api/knowledge", dependencies=[Depends(auth)])
    async def upload_knowledge(file: UploadFile = File(...)) -> dict:
        name = file.filename or ""
        if (Path(name).name != name or not re.fullmatch(r"[\w\-. ]{1,120}", name) or name.startswith(".")
                or Path(name).suffix.lower() not in TEXT_SUFFIXES):
            raise HTTPException(422, "допустимы файлы .md, .txt, .csv с простым именем")
        data = await file.read(MAX_KB_FILE_BYTES + 1)
        if len(data) > MAX_KB_FILE_BYTES:
            raise HTTPException(413, "файл больше 2 МБ")
        (_kb_dir() / name).write_bytes(data)
        return {"name": name, "chunks": await run_in_threadpool(runtime.reload_knowledge)}

    @app.delete("/api/knowledge/{name}", dependencies=[Depends(auth)])
    def delete_knowledge(name: str) -> dict:
        path = _kb_dir() / Path(name).name
        if not path.is_file():
            raise HTTPException(404, "не найдено")
        path.unlink()
        return {"deleted": name, "chunks": runtime.reload_knowledge()}

    # --- interception log (what the AI was asked and what it answered) --------------------
    @app.get("/api/traces", dependencies=[Depends(auth)])
    def traces(limit: int = Query(50, ge=1, le=500)) -> dict:
        llm = runtime.llm
        if not isinstance(llm, TracingLLM):
            return {"provider": runtime.mode, "records": []}
        records = [r.__dict__ for r in llm.records[-limit:]]
        return {"provider": llm.provider, "records": records,
                "issues": sum(1 for r in records if r["issues"])}

    return app


def serve(host: str = "127.0.0.1", port: int = 8000, token: str | None = None, data_dir: Path | None = None) -> None:
    """Run the server; prints ``RECAPPER_READY <url>`` once it accepts connections."""
    import uvicorn

    data_dir = Path(data_dir or default_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    base = Settings.from_env()
    import os

    if "RECAPPER_DB" not in os.environ:
        base.db_path = data_dir / "recapper.db"
    if base.knowledge_dir is None:
        base.knowledge_dir = data_dir / "knowledge"
    if base.asr_provider == "none" and "RECAPPER_ASR" not in os.environ:
        try:
            import faster_whisper  # noqa: F401  (bundled with the desktop app)

            base.asr_provider = "faster-whisper"
        except ImportError:
            pass
    app = create_app(base, api_token=token)
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    def announce() -> None:
        while not server.started and not server.should_exit:
            time.sleep(0.05)
        if server.started:
            print(f"RECAPPER_READY http://{host}:{port}", flush=True)
            if not token:
                print(f"RECAPPER_URL http://{host}:{port}/?token={app.state.token}", flush=True)

    threading.Thread(target=announce, daemon=True).start()
    server.run()
