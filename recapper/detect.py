"""Find questions and tasks in the conversation.

Two detectors share one interface:
- ``HeuristicDetector``: rule-based, offline, instant. Used without an API key
  and as a safety net.
- ``LLMDetector``: Claude with structured output. Understands context, drops
  jokes and rhetorical questions, rewrites items to be self-contained.
"""

from __future__ import annotations

import logging
import re
from typing import Protocol

from .knowledge import tokenize
from .llm import LLM, LLMError
from .models import Item, ItemKind, Segment
from .transcript import segments_to_text

log = logging.getLogger(__name__)

_SENTENCE_RE = re.compile(r"[^.!?…]+[.!?…]*", re.UNICODE)

# Short phatic questions that never need an answer.
_PHATIC = re.compile(
    r"^(да|нет|правда|ага|окей|ок|ну|слышно|видно|видно меня|слышно меня|меня слышно|меня видно|"
    r"все здесь|всё здесь|начинаем|понятно|ясно|так ведь|верно|согласны|можно|right|ok|okay|"
    r"can you hear me|can you see my screen|видно экран|видите экран)\??$",
    re.IGNORECASE,
)
# Phatic fragments anywhere in a short utterance ("Всем привет, слышно меня?").
_PHATIC_PART = re.compile(
    r"(слышно меня|меня слышно|видно меня|меня видно|видно экран|видите экран|видно мой экран|"
    r"на этом вс[её]|все здесь|всё здесь|все подключились|всех слышно|есть вопросы|"
    r"can you hear|can you see my|are we done|anything else)",
    re.IGNORECASE,
)
_TASK_TRIGGERS = re.compile(
    r"\b(надо|нужно|необходимо|требуется|давайте|давай|стоит|следует|предлагаю|"
    r"придума\w*|посчита\w*|рассчита\w*|дописа\w*|напиш\w*|подготов\w*|проверь|проверить|"
    r"разобраться|разберись|найти|найди|собери|собрать|оцени\w*|сравни\w*|"
    r"we need to|need to|let's|lets|should|todo|to-do|action item)\b",
    re.IGNORECASE,
)
# "надо сказать", "нужно отметить" are discourse markers, not tasks.
_TASK_FALSE = re.compile(
    r"\b(надо|нужно|стоит) (сказать|отметить|признать|понимать|заметить)\b|\bкак говорится\b",
    re.IGNORECASE,
)
_QUESTION_WORDS = re.compile(
    r"^(как|что|почему|зачем|сколько|какой|какая|какие|каким|где|когда|кто|чем|можно ли|стоит ли|"
    r"нужно ли|есть ли|how|what|why|which|where|when|who|should we|can we|is there)\b",
    re.IGNORECASE,
)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_RE.findall(text) if s.strip()]


def similarity(a: str, b: str) -> float:
    ta, tb = set(tokenize(a)), set(tokenize(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def is_duplicate(text: str, existing: list[Item], threshold: float = 0.6) -> bool:
    return any(similarity(text, item.text) >= threshold for item in existing)


def classify_sentence(sentence: str) -> ItemKind | None:
    s = sentence.strip()
    words = s.split()
    if len(words) < 3 or _PHATIC.match(s.lower().strip(" ,")):
        return None
    if len(words) <= 6 and _PHATIC_PART.search(s):
        return None
    if s.endswith("?"):
        return ItemKind.QUESTION
    if _QUESTION_WORDS.match(s) and len(words) >= 4:
        return ItemKind.QUESTION
    if _TASK_TRIGGERS.search(s) and not _TASK_FALSE.search(s):
        return ItemKind.TASK
    return None


class Detector(Protocol):
    def detect(self, new: list[Segment], context: list[Segment], known: list[Item]) -> list[Item]: ...


class HeuristicDetector:
    def detect(self, new: list[Segment], context: list[Segment], known: list[Item]) -> list[Item]:
        found: list[Item] = []
        for seg in new:
            for sentence in _sentences(seg.text):
                kind = classify_sentence(sentence)
                if kind is None:
                    continue
                text = sentence.rstrip(".…")
                if is_duplicate(text, known + found):
                    continue
                found.append(Item(kind=kind, text=text, quote=sentence, speaker=seg.speaker, start=seg.start))
        return found


DETECT_SYSTEM = """Ты — ассистент на рабочей встрече. Тебе дают свежий фрагмент расшифровки \
(и немного предыдущего контекста). Найди в СВЕЖЕМ фрагменте вопросы и задачи, на которые \
полезно заранее подготовить ответ или черновик: вопросы по сути дела, поручения \
("надо дописать механику монетизации", "посчитай конверсию", "найдите аналоги").

Не включай: приветствия, шутки, риторические вопросы, организационные мелочи \
("слышно меня?", "кто ведёт протокол?"), то, что уже решено прямо на встрече, и пункты \
из списка уже найденных.

Для каждого пункта:
- kind: "question" или "task";
- text: самодостаточная формулировка на языке встречи, понятная без расшифровки \
(раскрой местоимения и контекст: не "посчитать это", а "посчитать конверсию покупок из \
Самоката в Купер");
- quote: дословная цитата из фрагмента;
- speaker: кто сказал (если известно).
Если подходящих пунктов нет — верни пустой список."""

DETECT_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["question", "task"]},
                    "text": {"type": "string"},
                    "quote": {"type": "string"},
                    "speaker": {"type": "string"},
                },
                "required": ["kind", "text", "quote", "speaker"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


class LLMDetector:
    def __init__(self, llm: LLM, effort: str = "low", fallback: Detector | None = None):
        self.llm = llm
        self.effort = effort
        self.fallback = fallback or HeuristicDetector()

    def detect(self, new: list[Segment], context: list[Segment], known: list[Item]) -> list[Item]:
        if not new:
            return []
        known_list = "\n".join(f"- {i.text}" for i in known) or "(пока нет)"
        prompt = (
            f"Предыдущий контекст:\n{segments_to_text(context) or '(начало встречи)'}\n\n"
            f"СВЕЖИЙ фрагмент:\n{segments_to_text(new)}\n\n"
            f"Уже найденные пункты:\n{known_list}"
        )
        try:
            data = self.llm.json(DETECT_SYSTEM, prompt, DETECT_SCHEMA, self.effort)
        except LLMError as exc:
            log.warning("LLM detection failed, falling back to heuristics: %s", exc)
            return self.fallback.detect(new, context, known)
        found: list[Item] = []
        for raw in data.get("items", []):
            text = (raw.get("text") or "").strip()
            if not text or is_duplicate(text, known + found):
                continue
            quote = (raw.get("quote") or "").strip()
            seg = _locate(quote, new)
            found.append(
                Item(
                    kind=ItemKind(raw.get("kind", "question")),
                    text=text,
                    quote=quote,
                    speaker=(raw.get("speaker") or (seg.speaker if seg else "")).strip(),
                    start=seg.start if seg else None,
                )
            )
        return found


def _locate(quote: str, segments: list[Segment]) -> Segment | None:
    if not quote:
        return None
    best, best_score = None, 0.0
    for seg in segments:
        if quote in seg.text:
            return seg
        score = similarity(quote, seg.text)
        if score > best_score:
            best, best_score = seg, score
    return best if best_score >= 0.3 else None
