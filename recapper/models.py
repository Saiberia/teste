"""Data models shared by every module."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field


class Segment(BaseModel):
    """One utterance of the transcript."""

    speaker: str = ""
    text: str
    start: float | None = None  # seconds from meeting start
    end: float | None = None


class ItemKind(str, Enum):
    QUESTION = "question"  # "как нам поднять конверсию?"
    TASK = "task"  # "надо дописать механику монетизации"


class ItemOrigin(str, Enum):
    VOICE = "voice"  # dictated to the assistant during the meeting ("Ассистент, ...")
    MEETING = "meeting"  # heard in the conversation (suggestion)
    USER = "user"  # typed by the user


class Item(BaseModel):
    """A question or task that deserves an answer / draft."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    kind: ItemKind
    text: str  # normalized, self-contained formulation
    quote: str = ""  # what was literally said
    speaker: str = ""
    start: float | None = None
    origin: ItemOrigin = ItemOrigin.MEETING
    detector: str = ""  # command | llm | heuristic | user
    status: str = "active"  # active | cancelled (false voice trigger) | dismissed (hidden suggestion)
    parent_id: str | None = None  # a refinement ("Уточнить") of another item

    @property
    def is_command(self) -> bool:
        return self.origin in (ItemOrigin.VOICE, ItemOrigin.USER)


class Source(BaseModel):
    title: str
    ref: str  # URL or "doc:<file name>" or "transcript"


class AnswerStatus(str, Enum):
    DRAFT = "draft"  # produced by the model
    NEEDS_LLM = "needs_llm"  # offline mode: only context gathered
    FAILED = "failed"


class Answer(BaseModel):
    item_id: str
    status: AnswerStatus = AnswerStatus.DRAFT
    summary: str = ""  # one-line takeaway
    body: str = ""  # markdown draft
    assumptions: list[str] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    confidence: str = "low"  # low | medium | high
    warnings: list[str] = Field(default_factory=list)  # contract issues found in the model output


class ActionItem(BaseModel):
    text: str
    owner: str = ""
    due: str = ""
    done: bool = False


class RecapSection(BaseModel):
    title: str
    bullets: list[str] = Field(default_factory=list)


class Recap(BaseModel):
    summary: str = ""
    sections: list[RecapSection] = Field(default_factory=list)  # template-specific parts
    decisions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)


class MeetingReport(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = "Встреча"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))
    template: str = "general"
    reviewed: bool = False  # the user marked the AI draft as checked
    consent_noted: bool = False  # the user ticked "participants know about the recording"
    segments: list[Segment] = Field(default_factory=list)
    recap: Recap = Field(default_factory=Recap)
    items: list[Item] = Field(default_factory=list)
    answers: list[Answer] = Field(default_factory=list)
    mode: str = "offline"  # offline | claude

    def answer_for(self, item_id: str) -> Answer | None:
        return next((a for a in self.answers if a.item_id == item_id), None)

    def item(self, item_id: str) -> Item | None:
        return next((i for i in self.items if i.id == item_id), None)

    def rename_speaker(self, old: str, new: str) -> int:
        """Rename a speaker everywhere (segments, items, action items)."""
        count = 0
        for seg in self.segments:
            if seg.speaker == old:
                seg.speaker, count = new, count + 1
        for item in self.items:
            if item.speaker == old:
                item.speaker, count = new, count + 1
        for action in self.recap.action_items:
            if action.owner == old:
                action.owner, count = new, count + 1
        return count
