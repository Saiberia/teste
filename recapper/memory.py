"""Long-term memory: find what was said in earlier meetings.

"Ассистент, как мы в прошлый раз решили считать атрибуцию?" -> the answer
prompt receives the relevant fragments of past meetings, with their dates.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from .knowledge import Chunk, KnowledgeBase
from .models import MeetingReport
from .transcript import segments_to_text

if TYPE_CHECKING:
    from .store import ReportStore

WINDOW = 6  # segments per memory chunk
STEP = 4


@dataclass
class MemoryHit:
    meeting_id: str
    title: str
    date: str
    text: str
    score: float

    @property
    def ref(self) -> str:
        return f"meeting:{self.meeting_id}"


def report_chunks(report: MeetingReport) -> list[str]:
    chunks: list[str] = []
    segs = report.segments
    for start in range(0, max(len(segs) - WINDOW + STEP, 1), STEP):
        window = segs[start:start + WINDOW]
        if window:
            chunks.append(segments_to_text(window))
    if report.recap.summary or report.recap.decisions:
        chunks.append("Итог: " + report.recap.summary + "\nРешения: " + "; ".join(report.recap.decisions))
    for item in report.items:
        answer = report.answer_for(item.id)
        if answer and answer.summary:
            chunks.append(f"Вопрос/задача: {item.text}\nОтвет ассистента: {answer.summary}")
    return chunks


class MeetingMemory:
    def __init__(self, store: "ReportStore", owner: str, max_meetings: int = 200):
        self.store = store
        self.owner = owner
        self.max_meetings = max_meetings

    def search(self, query: str, exclude_id: str | None = None, k: int = 4) -> list[MemoryHit]:
        reports = [r for r in self.store.all(self.owner, limit=self.max_meetings) if r.id != exclude_id]
        if not reports:
            return []
        kb = KnowledgeBase()
        meta: dict[str, MeetingReport] = {}
        for report in reports:
            meta[report.id] = report
            for text in report_chunks(report):
                kb.add(Chunk(doc=report.id, text=text))
        hits = []
        for chunk, score in kb.search(query, k=k):
            report = meta[chunk.doc]
            hits.append(MemoryHit(report.id, report.title, report.created_at[:10], chunk.text, score))
        return hits
