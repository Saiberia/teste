"""Meeting recap: summary, decisions, action items."""

from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Protocol

from .knowledge import _STOP, _WORD_RE
from .llm import LLM, LLMError
from .models import ActionItem, Recap, Segment
from .transcript import segments_to_text

log = logging.getLogger(__name__)

_DECISION = re.compile(
    r"\b(решили|решено|договорились|утвердили|принимаем|фиксируем|итого|выбираем|остановимся на|"
    r"we decided|agreed|decision)\b",
    re.IGNORECASE,
)
_OWN_TASK = re.compile(r"\b(я возьму|я сделаю|беру на себя|я подготовлю|я посчитаю|я напишу|i'll|i will)\b", re.IGNORECASE)
_ASSIGN = re.compile(
    r"^(?P<who>[А-ЯЁA-Z][а-яёa-z]+)[,:]\s*(?:ты\s+)?(?:возьми|сделай|подготовь|посчитай|напиши|проверь|"
    r"допиши|найди|собери|please|can you)\b",
)
_DUE = re.compile(
    r"\b((?:до|к|by)\s+(?:понедельник\w*|вторник\w*|сред\w*|четверг\w*|пятниц\w*|суббот\w*|"
    r"воскресень\w*|завтр\w*|конц\w* недели|конц\w* месяца|\d{1,2}(?:[./]\d{1,2})?(?:\s+\w+)?|"
    r"monday|tuesday|wednesday|thursday|friday|tomorrow|end of week)|завтра|сегодня)\b",
    re.IGNORECASE,
)
_SENT = re.compile(r"[^.!?…]+[.!?…]*")
_FILLER = {"слышно", "привет", "всем", "сегодня", "вообще", "кстати", "ладно", "хороший", "вопрос",
           "окей", "спасибо", "давайте", "нужно", "будем"}


class Recapper(Protocol):
    def recap(self, segments: list[Segment]) -> Recap: ...


class HeuristicRecapper:
    def recap(self, segments: list[Segment]) -> Recap:
        decisions: list[str] = []
        actions: list[ActionItem] = []
        for seg in segments:
            for sentence in (s.strip() for s in _SENT.findall(seg.text)):
                if not sentence:
                    continue
                if _DECISION.search(sentence):
                    decisions.append(sentence)
                owner = ""
                assign = _ASSIGN.match(sentence)
                if assign:
                    owner = assign.group("who")
                elif _OWN_TASK.search(sentence):
                    owner = seg.speaker
                if owner:
                    due = _DUE.search(sentence)
                    actions.append(ActionItem(text=sentence, owner=owner, due=due.group(0) if due else ""))
        speakers = sorted({s.speaker for s in segments if s.speaker})
        words = Counter(
            w for s in segments for w in _WORD_RE.findall(s.text.lower())
            if len(w) > 4 and w not in _STOP and w not in _FILLER
        )
        topics = ", ".join(w for w, _ in words.most_common(6))
        summary = (
            f"Участники: {', '.join(speakers) or 'не указаны'}. Реплик: {len(segments)}. "
            f"Частые темы: {topics or '—'}. "
            "(Офлайн-режим: связный пересказ появится при подключённом Claude.)"
        )
        return Recap(summary=summary, decisions=decisions, action_items=actions)


RECAP_SYSTEM = """Ты готовишь итог рабочей встречи по расшифровке. Пиши на языке встречи, \
кратко и по делу. Не выдумывай: в итог попадает только то, что прозвучало. \
Шутки и отвлечённые разговоры не включай.
- summary: 3–6 предложений — о чём говорили и к чему пришли;
- decisions: только реально принятые решения (не предложения);
- action_items: поручения с ответственным (owner) и сроком (due), если они прозвучали, \
иначе пустая строка."""

RECAP_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "decisions": {"type": "array", "items": {"type": "string"}},
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "owner": {"type": "string"},
                    "due": {"type": "string"},
                },
                "required": ["text", "owner", "due"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "decisions", "action_items"],
    "additionalProperties": False,
}


class LLMRecapper:
    def __init__(self, llm: LLM, effort: str = "medium", fallback: Recapper | None = None):
        self.llm = llm
        self.effort = effort
        self.fallback = fallback or HeuristicRecapper()

    def recap(self, segments: list[Segment]) -> Recap:
        if not segments:
            return Recap()
        try:
            data = self.llm.json(RECAP_SYSTEM, segments_to_text(segments), RECAP_SCHEMA, self.effort)
            return Recap.model_validate(data)
        except (LLMError, ValueError) as exc:
            log.warning("LLM recap failed, falling back to heuristics: %s", exc)
            return self.fallback.recap(segments)
