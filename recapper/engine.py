"""Wires detection, answering, memory and recap together; live and batch modes."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from .answer import Answerer, LLMAnswerer, MemorySearch, OfflineAnswerer
from .assist import Assistant
from .config import Settings
from .detect import CommandDetector, Detector, HeuristicDetector, LLMDetector, is_duplicate
from .knowledge import KnowledgeBase
from .llm import LLM, LLMError
from .models import Answer, AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport, Segment
from .providers import make_llm, provider_name
from .recap import HeuristicRecapper, LLMRecapper, Recapper

if TYPE_CHECKING:
    from .store import ReportStore

log = logging.getLogger(__name__)

CONTEXT_SEGMENTS = 6  # previous segments shown to the detector
DETECT_MIN_CHARS = 600  # batch new speech before calling a model-based detector
BATCH_CHUNK_CHARS = 6000  # batch mode: detection runs over chunks of this size
MAX_ANSWERS = 30  # per meeting: caps model spend
MAX_DETECT_RETRIES = 2
FINISH_DEADLINE = 600.0  # seconds to wait for outstanding answers when finishing


class SessionClosed(RuntimeError):
    pass


@dataclass
class Components:
    detector: Detector | None  # suggestions from the conversation
    answerer: Answerer
    recapper: Recapper
    mode: str
    llm: LLM | None = None
    commands: CommandDetector = field(default_factory=CommandDetector)
    assistant: Assistant | None = None

    def __post_init__(self) -> None:
        if self.assistant is None:
            self.assistant = Assistant(self.llm)


def build_components(settings: Settings, kb: KnowledgeBase | None = None, llm: LLM | None = None,
                     title: str = "Встреча", memory: MemorySearch | None = None, template: str = "general") -> Components:
    kb = kb if kb is not None else KnowledgeBase.from_dir(settings.knowledge_dir)
    mode = "custom" if llm is not None else provider_name(settings)
    if llm is None:
        llm = make_llm(settings)
    if llm is None:
        return Components(HeuristicDetector(), OfflineAnswerer(kb, memory), HeuristicRecapper(), "offline")
    return Components(
        LLMDetector(llm, effort=settings.detect_effort),
        LLMAnswerer(llm, kb, effort=settings.answer_effort, web_search=settings.web_search, title=title, memory=memory),
        LLMRecapper(llm, template=template),
        mode,
        llm,
    )


class Runtime:
    """Process-wide shared state: one AI client, one knowledge base, one store.

    ``apply_settings`` swaps the provider/knowledge base live when the user
    changes settings; running sessions keep the components they started with.
    """

    def __init__(self, settings: Settings, store: "ReportStore", llm: LLM | None = None,
                 kb: KnowledgeBase | None = None):
        self._lock = threading.RLock()
        self.store = store
        self._fixed_llm = llm
        self.settings = settings
        self.kb = kb if kb is not None else KnowledgeBase.from_dir(settings.knowledge_dir)
        self._llm: LLM | None = None
        self.mode = "offline"
        self.llm_error = ""
        self._build_llm()

    def _build_llm(self) -> None:
        self.llm_error = ""
        if self._fixed_llm is not None:
            self._llm, self.mode = self._fixed_llm, "custom"
            return
        try:
            self._llm = make_llm(self.settings)
        except LLMError as exc:  # e.g. provider "openai" without a URL: run offline, report why
            self._llm, self.llm_error = None, str(exc)
        self.mode = provider_name(self.settings) if self._llm else "offline"

    @property
    def llm(self) -> LLM | None:
        return self._llm

    def apply_settings(self, settings: Settings) -> None:
        from .prefs import AI_KEYS

        with self._lock:
            old = self.settings
            self.settings = settings
            if any(getattr(old, k) != getattr(settings, k) for k in AI_KEYS):
                self._build_llm()
            if old.knowledge_dir != settings.knowledge_dir:
                self.kb = KnowledgeBase.from_dir(settings.knowledge_dir)

    def reload_knowledge(self) -> int:
        kb = KnowledgeBase.from_dir(self.settings.knowledge_dir)
        with self._lock:
            self.kb = kb
        return len(kb)

    def memory(self, owner: str, exclude_id: str | None = None) -> MemorySearch:
        from .memory import MeetingMemory

        mem = MeetingMemory(self.store, owner)
        return lambda query: mem.search(query, exclude_id=exclude_id)

    def components(self, title: str, owner: str, exclude_id: str | None = None, template: str | None = None) -> Components:
        with self._lock:
            s, llm, kb, mode = self.settings, self._llm, self.kb, self.mode
        template = template or s.default_template
        memory = self.memory(owner, exclude_id)
        commands = CommandDetector(s.wake_word_list)
        if llm is None:
            return Components(HeuristicDetector() if s.suggestions_enabled else None, OfflineAnswerer(kb, memory),
                              HeuristicRecapper(), "offline", None, commands, Assistant(None))
        return Components(
            LLMDetector(llm, effort=s.detect_effort) if s.suggestions_enabled else None,
            LLMAnswerer(llm, kb, effort=s.answer_effort, web_search=s.web_search, title=title, memory=memory,
                        language=s.answer_language),
            LLMRecapper(llm, template=template, language=s.answer_language),
            mode,
            llm,
            commands,
            Assistant(llm, language=s.answer_language),
        )

    def session(self, title: str, owner: str, template: str | None = None, auto_answer: str | None = None) -> "LiveSession":
        s = self.settings
        template = template or s.default_template
        return LiveSession(self.components(title, owner, template=template), title=title,
                           min_chars=s.detect_min_chars, auto_answer=auto_answer or s.auto_answer,
                           max_answers=s.max_answers, template=template)


@dataclass
class Event:
    seq: int
    type: str  # item | answer | recap | assist | error | limit | done
    data: dict[str, Any]


class LiveSession:
    """Accepts transcript segments as they arrive and answers in the background.

    Lifecycle: open -> closing -> finished. Input is rejected once closing, so
    nothing said after "finish" is silently lost.
    """

    def __init__(self, components: Components, title: str = "Встреча", max_workers: int = 4,
                 min_chars: int = DETECT_MIN_CHARS, auto_answer: str = "commands", max_answers: int = MAX_ANSWERS,
                 template: str = "general"):
        self.c = components
        self.report = MeetingReport(title=title, mode=components.mode, template=template)
        self.min_chars = min_chars if isinstance(components.detector, LLMDetector) else 0
        self.auto_answer = auto_answer  # commands | all
        self.max_answers = max_answers
        self.state = "open"
        self.last_activity = time.monotonic()
        self._lock = threading.RLock()
        self._finish_lock = threading.Lock()
        self._detect_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="answer")
        self._futures: dict[str, Future] = {}
        self._events: list[Event] = []
        self.participants = []  # names said to the assistant or read from the meeting page; hints for labels
        self.speaker_events: list[tuple[float, str]] = []  # (unix time, who is speaking; "" = nobody) from the page
        self.audio_anchor: float | None = None  # unix time of audio offset 0 (estimated from uploads)
        self._pending: list[Segment] = []  # not yet shown to the suggestion detector
        self._retries = 0

    @property
    def finished(self) -> bool:
        return self.state == "finished"

    # --- events -------------------------------------------------------
    def _emit(self, type_: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._events.append(Event(len(self._events) + 1, type_, data))

    def events(self, since: int = 0) -> list[Event]:
        with self._lock:
            return [e for e in self._events if e.seq > since]

    def _touch(self) -> None:
        self.last_activity = time.monotonic()

    def _require_open(self) -> None:
        if self.state != "open":
            raise SessionClosed("сессия уже завершается или завершена")

    # --- input ----------------------------------------------------------
    def add_segments(self, segments: list[Segment], flush: bool = False) -> list[Item]:
        with self._lock:
            self._require_open()
            self._touch()
            self.report.segments.extend(segments)
            self._pending.extend(segments)
            start = len(self.report.segments) - len(segments)
            context = self.report.segments[max(0, start - CONTEXT_SEGMENTS):start]
            known = list(self.report.items)
        # Voice commands are recognised immediately, on every segment.
        commands = [c for c in self.c.commands.detect(segments, context, known) if not self._speaker_command(c.text)]
        added = self._add_items(commands)
        with self._lock:
            pending_chars = sum(len(s.text) for s in self._pending)
        if flush or pending_chars >= self.min_chars:
            added += self._detect()
        return added

    participants: list[str]

    def add_speaker_events(self, events: list[tuple[float, str]], participants: list[str]) -> None:
        with self._lock:
            self.speaker_events.extend(events)
            self.speaker_events.sort(key=lambda e: e[0])
            del self.speaker_events[:-5000]
            for name in participants:
                if name and name not in self.participants:
                    self.participants.append(name)

    def note_audio_clock(self, arrived: float, offset: float, duration: float) -> None:
        """A chunk covering [offset, offset+duration] arrived at ``arrived``: estimate when offset 0 was.
        The smallest estimate has the least upload delay in it."""
        cand = arrived - offset - duration
        with self._lock:
            self.audio_anchor = cand if self.audio_anchor is None else min(self.audio_anchor, cand)

    def speaker_at(self, start: float, end: float) -> str:
        """Who spoke most in [start, end] (audio offsets) according to the meeting page; "" if unclear."""
        with self._lock:
            events = list(self.speaker_events)
            anchor = self.audio_anchor
        if not events or end <= start or anchor is None:
            return ""
        start, end = start + anchor, end + anchor
        spans: dict[str, float] = {}
        for i, (t, name) in enumerate(events):
            t_end = events[i + 1][0] if i + 1 < len(events) else t + 15.0  # the last event holds for a while
            lo, hi = max(t, start), min(t_end, end)
            if name and hi > lo:
                spans[name] = spans.get(name, 0.0) + hi - lo
        if not spans:
            return ""
        name, span = max(spans.items(), key=lambda kv: kv[1])
        return name if span >= 0.6 * (end - start) else ""

    def _speaker_command(self, text: str) -> bool:
        """«Собеседник 1 — это Артём» renames; «на встрече Артём и Мария» sets participants. True if handled."""
        import re

        m = re.search(r"(собеседник\s*\d+)\s*(?:[—–-]\s*)?(?:это\s+)?([A-ZА-ЯЁ][\w-]+)", text, re.I)
        if m:
            old = next((sp for sp in {x.speaker for x in self.report.segments}
                        if sp.lower().replace(" ", "") == m.group(1).lower().replace(" ", "")), None)
            if old:
                with self._lock:
                    self.report.rename_speaker(old, m.group(2).capitalize())
                return True
        m = re.search(r"(?:на встрече|участники|участвуют)[:\s]+(.+)", text, re.I)
        if m:
            names = [n.strip(" .,").capitalize() for n in re.split(r",|\sи\s", m.group(1)) if n.strip(" .,")]
            if names and all(len(n.split()) <= 2 for n in names):
                self.participants = names
                return True
        return False

    def _add_items(self, items: list[Item]) -> list[Item]:
        # Adding and scheduling happen under one lock, so finish() can never seal the
        # report between "item accepted" and "answer scheduled".
        with self._lock:
            if self.state in ("sealing", "finished"):
                raise SessionClosed("встреча уже завершена")
            fresh = [i for i in items if not (not i.is_command and is_duplicate(i.text, self.report.items))]
            self.report.items.extend(fresh)
            for item in fresh:
                self._emit("item", item.model_dump(mode="json"))
                if item.is_command or self.auto_answer == "all":
                    self._submit(item)
        return fresh

    def _detect(self, final: bool = False) -> list[Item]:
        if self.c.detector is None:
            with self._lock:
                self._pending = []
            return []
        # One detector call at a time keeps "already known" dedup consistent.
        with self._detect_lock:
            with self._lock:
                new, self._pending = self._pending, []
                if not new:
                    return []
                start = len(self.report.segments) - len(new)
                context = self.report.segments[max(0, start - CONTEXT_SEGMENTS):start]
                known = list(self.report.items)
            try:
                items = self.c.detector.detect(new, context, known)
                self._retries = 0
            except LLMError as exc:
                self._retries += 1
                retry = self._retries <= MAX_DETECT_RETRIES and not final
                if retry:  # put the speech back, try again with the next chunk
                    with self._lock:
                        self._pending = new + self._pending
                self._emit("error", {"message": f"поиск вопросов: {exc}", "retry": retry})
                return []
            except Exception as exc:  # detector bugs must not kill the meeting
                log.exception("detector failed")
                self._emit("error", {"message": f"поиск вопросов: {exc}", "retry": False})
                return []
            items = [i for i in items if not i.is_command]
        return self._add_items(items)

    def ask(self, question: str) -> Item:
        """A question typed by the user; answered like a voice command."""
        item = Item(kind=ItemKind.QUESTION, text=question.strip(), origin=ItemOrigin.USER, detector="user")
        with self._lock:
            self._require_open()
            self._touch()
            self.report.items.append(item)
            self._emit("item", item.model_dump(mode="json"))
            self._submit(item)
        return item

    def request_answer(self, item_id: str) -> Item:
        """Answer a suggestion the user clicked on, or retry a finished/failed answer."""
        with self._lock:
            self._require_open()
            item = self._item(item_id)
            fut = self._futures.get(item_id)
            if fut is not None and fut.done():
                del self._futures[item_id]  # retry
            if item.status != "active":
                item.status = "active"
                self._emit("item", item.model_dump(mode="json"))
            self._submit(item)
        return item

    def set_item_status(self, item_id: str, status: str) -> Item:
        """Cancel a false voice trigger, dismiss a suggestion, or restore either."""
        if status not in ("active", "cancelled", "dismissed"):
            raise ValueError(status)
        with self._lock:
            self._require_open()
            item = self._item(item_id)
            item.status = status
            if status != "active":
                fut = self._futures.pop(item_id, None)
                if fut is not None:
                    fut.cancel()  # a running answer finishes but is discarded in _answer
                self.report.answers = [a for a in self.report.answers if a.item_id != item_id]
            self._emit("item", item.model_dump(mode="json"))
            if status == "active" and item.is_command and self.report.answer_for(item_id) is None:
                self._submit(item)  # a restored command gets its answer again
        return item

    def refine(self, item_id: str, text: str) -> Item:
        """A follow-up to an answered item ("Уточнить"): answered with the previous answer as context."""
        with self._lock:
            self._require_open()
            parent = self._item(item_id)
            prev = self.report.answer_for(item_id)
            context = f"Уточнение к задаче «{parent.text}»."
            if prev and prev.summary:
                context += f" Предыдущий ответ: {prev.summary}"
            item = Item(kind=ItemKind.QUESTION if text.strip().endswith("?") else ItemKind.TASK,
                        text=text.strip(), quote=context, origin=ItemOrigin.USER, detector="user", parent_id=item_id)
            self.report.items.append(item)
            self._emit("item", item.model_dump(mode="json"))
            self._submit(item)
        return item

    def _item(self, item_id: str) -> Item:
        item = self.report.item(item_id)
        if item is None:
            raise KeyError(item_id)
        return item

    # --- answering ------------------------------------------------------
    def _submit(self, item: Item) -> None:
        with self._lock:
            if item.id in self._futures:
                return
            if self.state in ("sealing", "finished"):
                raise SessionClosed("встреча уже завершена")
            if len(self._futures) >= self.max_answers:
                message = f"достигнут лимит {self.max_answers} ответов"
                self._emit("limit", {"item_id": item.id, "message": message})
                # A visible terminal state instead of "in progress" forever.
                answer = Answer(item_id=item.id, status=AnswerStatus.FAILED, summary="Достигнут лимит ответов",
                                body=f"На этой встрече {message}. Увеличьте лимит в настройках или ответьте позже.")
                self.report.answers = [a for a in self.report.answers if a.item_id != item.id] + [answer]
                self._emit("answer", answer.model_dump(mode="json"))
                return
            self._futures[item.id] = self._pool.submit(self._answer, item)

    def _answer(self, item: Item) -> None:
        with self._lock:
            segments = list(self.report.segments)

        def progress(stage: str, **info: Any) -> None:
            with self._lock:
                if item.status != "active" or self.state in ("sealing", "finished"):
                    return
            self._emit("stage", {"item_id": item.id, "stage": stage, **info})

        try:
            answer = self.c.answerer.answer(item, segments, progress=progress)
        except Exception as exc:
            log.exception("answerer failed")
            answer = Answer(item_id=item.id, status=AnswerStatus.FAILED, summary="Ошибка", body=str(exc))
        with self._lock:
            if self.state in ("sealing", "finished") or item.status != "active":
                return  # sealed report, or the user cancelled the command meanwhile
            self.report.answers = [a for a in self.report.answers if a.item_id != item.id] + [answer]
            self._emit("answer", answer.model_dump(mode="json"))

    # --- live assist ----------------------------------------------------
    def assist(self, action: str, minutes: float = 1.0) -> dict:
        with self._lock:
            segments = list(self.report.segments)
        result = self.c.assistant.run(action, segments, minutes=minutes)
        self._emit("assist", {"action": action, **result})
        return result

    # --- finish ---------------------------------------------------------
    def finish(self, deadline: float = FINISH_DEADLINE,
               before_done: Callable[[MeetingReport], None] | None = None) -> MeetingReport:
        """Seal the meeting: wait for answers (up to ``deadline``), build the recap,
        call ``before_done`` (e.g. save the report), then emit ``done``."""
        with self._finish_lock:  # concurrent callers wait for the first one
            if self.state == "finished":
                return self.report
            with self._lock:
                self.state = "closing"
            self._detect(final=True)
            end = time.monotonic() + deadline
            while True:  # loop: an answer may still be submitted while we wait
                with self._lock:
                    waiting = [f for f in self._futures.values() if not f.done()]
                remaining = end - time.monotonic()
                if not waiting or remaining <= 0:
                    break
                wait(waiting, timeout=remaining)
            with self._lock:
                self.state = "sealing"  # from here on nothing new is accepted or recorded
                answered = {a.item_id for a in self.report.answers}
                for iid, fut in self._futures.items():
                    item = self.report.item(iid)
                    if iid not in answered and item is not None and item.status == "active":
                        fut.cancel()
                        self.report.answers.append(Answer(item_id=iid, status=AnswerStatus.FAILED,
                                                          summary="Не успело до завершения встречи",
                                                          body="Ответ не был готов к дедлайну; запросите его ещё раз."))
                segments = list(self.report.segments)
            try:
                self.report.recap = self.c.recapper.recap(segments)
            except Exception as exc:
                log.exception("recap failed")
                self._emit("error", {"message": f"итог: {exc}", "retry": False})
            self._emit("recap", self.report.recap.model_dump(mode="json"))
            with self._lock:
                self.state = "finished"
            self._pool.shutdown(wait=False, cancel_futures=True)
            if before_done is not None:
                try:
                    before_done(self.report)
                except Exception as exc:  # never swallow the report silently
                    log.exception("before_done failed")
                    self._emit("error", {"message": f"не удалось сохранить отчёт: {exc}", "retry": False})
            self._emit("done", {"id": self.report.id})
            return self.report

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def _chunks(segments: list[Segment], size: int = BATCH_CHUNK_CHARS) -> list[list[Segment]]:
    out, buf, n = [], [], 0
    for seg in segments:
        buf.append(seg)
        n += len(seg.text)
        if n >= size:
            out.append(buf)
            buf, n = [], 0
    if buf:
        out.append(buf)
    return out


def process_segments(segments: list[Segment], components: Components, title: str = "Встреча",
                     questions: list[str] | None = None, auto_answer: str = "commands",
                     max_questions: int = 20, template: str = "general") -> MeetingReport:
    """Batch mode: a finished recording/transcript in, full report out."""
    session = LiveSession(components, title=title, auto_answer=auto_answer, template=template)
    try:
        for chunk in _chunks(segments):
            session.add_segments(chunk, flush=True)
        for q in [q for q in (questions or []) if q.strip()][:max_questions]:
            session.ask(q)
        return session.finish()
    finally:
        session.close()
