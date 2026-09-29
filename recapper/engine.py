"""Wires detectors, answerers and recap together; live and batch modes."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .answer import Answerer, LLMAnswerer, OfflineAnswerer
from .config import Settings
from .detect import Detector, HeuristicDetector, LLMDetector, is_duplicate
from .knowledge import KnowledgeBase
from .llm import LLM, ClaudeLLM
from .models import Answer, AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport, Segment
from .recap import HeuristicRecapper, LLMRecapper, Recapper

log = logging.getLogger(__name__)

CONTEXT_SEGMENTS = 6  # previous segments shown to the detector
DETECT_MIN_CHARS = 200  # batch new speech before calling the detector


@dataclass
class Components:
    detector: Detector
    answerer: Answerer
    recapper: Recapper
    mode: str


def build_components(settings: Settings, kb: KnowledgeBase | None = None, llm: LLM | None = None,
                     title: str = "Встреча") -> Components:
    kb = kb if kb is not None else KnowledgeBase.from_dir(settings.knowledge_dir)
    if llm is None and settings.has_claude:
        llm = ClaudeLLM(model=settings.model, web_search_max_uses=settings.web_search_max_uses)
    if llm is None:
        return Components(HeuristicDetector(), OfflineAnswerer(kb), HeuristicRecapper(), "offline")
    return Components(
        LLMDetector(llm, effort=settings.detect_effort),
        LLMAnswerer(llm, kb, effort=settings.answer_effort, web_search=settings.web_search, title=title),
        LLMRecapper(llm),
        "claude",
    )


@dataclass
class Event:
    seq: int
    type: str  # item | answer | recap | error
    data: dict[str, Any]


class LiveSession:
    """Accepts transcript segments as they arrive and answers in the background.

    Thread-safe: segments may come from a web request while answers are being
    produced on worker threads.
    """

    def __init__(self, components: Components, title: str = "Встреча", max_workers: int = 4,
                 min_chars: int = DETECT_MIN_CHARS):
        self.c = components
        self.report = MeetingReport(title=title, mode=components.mode)
        self.min_chars = min_chars
        self._lock = threading.RLock()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="answer")
        self._futures: list[Future] = []
        self._events: list[Event] = []
        self._pending: list[Segment] = []  # not yet shown to the detector
        self._detect_lock = threading.Lock()
        self.finished = False

    # --- events -------------------------------------------------------
    def _emit(self, type_: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._events.append(Event(len(self._events) + 1, type_, data))

    def events(self, since: int = 0) -> list[Event]:
        with self._lock:
            return [e for e in self._events if e.seq > since]

    # --- input ----------------------------------------------------------
    def add_segments(self, segments: list[Segment], flush: bool = False) -> list[Item]:
        if self.finished:
            raise RuntimeError("session already finished")
        with self._lock:
            self.report.segments.extend(segments)
            self._pending.extend(segments)
            pending_chars = sum(len(s.text) for s in self._pending)
            if not flush and pending_chars < self.min_chars:
                return []
        return self._detect()

    def _detect(self) -> list[Item]:
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
            except Exception as exc:  # detector bugs must not kill the meeting
                log.exception("detector failed")
                self._emit("error", {"message": f"detector: {exc}"})
                return []
            with self._lock:
                items = [i for i in items if not is_duplicate(i.text, self.report.items)]
                self.report.items.extend(items)
            for item in items:
                self._emit("item", item.model_dump(mode="json"))
                self._submit(item)
            return items

    def ask(self, question: str) -> Item:
        """A question typed by the user; answered like one heard in the meeting."""
        item = Item(kind=ItemKind.QUESTION, text=question.strip(), origin=ItemOrigin.USER)
        with self._lock:
            self.report.items.append(item)
        self._emit("item", item.model_dump(mode="json"))
        self._submit(item)
        return item

    # --- answering ------------------------------------------------------
    def _submit(self, item: Item) -> None:
        with self._lock:
            self._futures.append(self._pool.submit(self._answer, item))

    def _answer(self, item: Item) -> None:
        with self._lock:
            segments = list(self.report.segments)
        try:
            answer = self.c.answerer.answer(item, segments)
        except Exception as exc:
            log.exception("answerer failed")
            answer = Answer(item_id=item.id, status=AnswerStatus.FAILED, summary="Ошибка", body=str(exc))
        with self._lock:
            self.report.answers = [a for a in self.report.answers if a.item_id != item.id] + [answer]
        self._emit("answer", answer.model_dump(mode="json"))

    def wait(self, timeout: float | None = None) -> None:
        with self._lock:
            futures = list(self._futures)
        for fut in futures:
            fut.result(timeout=timeout)

    # --- finish ---------------------------------------------------------
    def finish(self, timeout: float | None = None) -> MeetingReport:
        if not self.finished:
            self._detect()
            self.wait(timeout)
            with self._lock:
                segments = list(self.report.segments)
            try:
                self.report.recap = self.c.recapper.recap(segments)
            except Exception as exc:
                log.exception("recap failed")
                self._emit("error", {"message": f"recap: {exc}"})
            self._emit("recap", self.report.recap.model_dump(mode="json"))
            self.finished = True
            self._pool.shutdown(wait=False)
        return self.report

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def process_segments(segments: list[Segment], components: Components, title: str = "Встреча",
                     questions: list[str] | None = None) -> MeetingReport:
    """Batch mode: a finished recording/transcript in, full report out."""
    session = LiveSession(components, title=title)
    try:
        session.add_segments(segments, flush=True)
        for q in questions or []:
            if q.strip():
                session.ask(q)
        return session.finish()
    finally:
        session.close()
