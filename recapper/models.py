"""Data models shared by every module."""

from __future__ import annotations

import uuid
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
    MEETING = "meeting"  # heard in the conversation
    USER = "user"  # asked explicitly by the user


class Item(BaseModel):
    """A question or task that deserves an answer / draft."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    kind: ItemKind
    text: str  # normalized, self-contained formulation
    quote: str = ""  # what was literally said
    speaker: str = ""
    start: float | None = None
    origin: ItemOrigin = ItemOrigin.MEETING


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


class ActionItem(BaseModel):
    text: str
    owner: str = ""
    due: str = ""


class Recap(BaseModel):
    summary: str = ""
    decisions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)


class MeetingReport(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = "Встреча"
    segments: list[Segment] = Field(default_factory=list)
    recap: Recap = Field(default_factory=Recap)
    items: list[Item] = Field(default_factory=list)
    answers: list[Answer] = Field(default_factory=list)
    mode: str = "offline"  # offline | claude

    def answer_for(self, item_id: str) -> Answer | None:
        return next((a for a in self.answers if a.item_id == item_id), None)
