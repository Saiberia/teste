"""Turn a detected question/task into a draft answer with sources."""

from __future__ import annotations

import logging
import re
from typing import Protocol

from .knowledge import KnowledgeBase
from .llm import LLM, LLMError
from .models import Answer, AnswerStatus, Item, ItemKind, Segment, Source
from .transcript import segments_to_text

log = logging.getLogger(__name__)

MAX_TRANSCRIPT_CHARS = 60_000
CONTEXT_WINDOW = 12  # segments around the item when the transcript is long


def transcript_context(item: Item, segments: list[Segment]) -> str:
    text = segments_to_text(segments)
    if len(text) <= MAX_TRANSCRIPT_CHARS:
        return text
    idx = 0
    if item.quote:
        for i, seg in enumerate(segments):
            if item.quote[:40] in seg.text:
                idx = i
                break
    lo, hi = max(0, idx - CONTEXT_WINDOW), idx + CONTEXT_WINDOW // 2
    return "…\n" + segments_to_text(segments[lo:hi]) + "\n…"


def knowledge_context(item: Item, kb: KnowledgeBase, k: int = 4) -> tuple[str, list[Source]]:
    hits = kb.search(f"{item.text} {item.quote}", k=k)
    if not hits:
        return "", []
    parts, sources, seen = [], [], set()
    for chunk, _score in hits:
        parts.append(f"[doc:{chunk.doc}]\n{chunk.text}")
        if chunk.doc not in seen:
            seen.add(chunk.doc)
            sources.append(Source(title=chunk.doc, ref=f"doc:{chunk.doc}"))
    return "\n\n".join(parts), sources


class Answerer(Protocol):
    def answer(self, item: Item, segments: list[Segment]) -> Answer: ...


class OfflineAnswerer:
    """No model available: gather everything a human needs to answer quickly."""

    def __init__(self, kb: KnowledgeBase | None = None):
        self.kb = kb or KnowledgeBase()

    def answer(self, item: Item, segments: list[Segment]) -> Answer:
        kb_text, sources = knowledge_context(item, self.kb, k=3)
        body = ["Черновик не сгенерирован: не подключён Claude (нет ANTHROPIC_API_KEY)."]
        if kb_text:
            body.append("\n**Что нашлось в базе знаний:**\n")
            for chunk, _ in self.kb.search(f"{item.text} {item.quote}", k=3):
                snippet = chunk.text if len(chunk.text) < 400 else chunk.text[:400] + "…"
                body.append(f"- _{chunk.doc}_: {snippet}")
        else:
            body.append("\nВ базе знаний ничего подходящего не нашлось.")
        return Answer(
            item_id=item.id,
            status=AnswerStatus.NEEDS_LLM,
            summary="Нужен ответ: " + item.text,
            body="\n".join(body),
            sources=sources,
            confidence="low",
        )


ANSWER_SYSTEM = """Ты — сильный продуктовый аналитик и ассистент команды. Во время встречи \
прозвучал вопрос или задача. Подготовь практичный черновик, который человек сможет сразу \
использовать: варианты решения, механику, расчёт, шаги, риски — что уместно.

Правила:
- Опирайся в первую очередь на материалы компании ([doc:...]) и контекст встречи; \
веб-поиск используй для фактов о рынке, бенчмарков и аналогов.
- Не выдумывай цифры. Любую оценку помечай как допущение и показывай, из чего она получена.
- Если данных не хватает — скажи, каких именно, и дай черновик с явными допущениями.
- Ссылайся на материалы компании как [doc:имя файла].
- Пиши на языке встречи, структурно, без воды.

Формат ответа строго такой (заголовки не меняй):
## Коротко
Одна-две фразы: главный ответ.
## Черновик
Основная часть в markdown.
## Допущения
- по одному на строку (или "- нет")
## Уверенность
одно слово: low, medium или high"""

_SECTION_RE = re.compile(r"^##\s*(Коротко|Черновик|Допущения|Уверенность)\s*$", re.IGNORECASE | re.MULTILINE)


def parse_answer_text(text: str) -> dict:
    """Split the model's markdown into fields; tolerant to missing sections."""
    sections: dict[str, str] = {}
    matches = list(_SECTION_RE.finditer(text))
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[match.group(1).lower()] = text[match.end():end].strip()
    if not matches:
        first = text.strip().split("\n", 1)[0]
        return {"summary": first[:300], "body": text.strip(), "assumptions": [], "confidence": "low"}
    assumptions = [
        line.lstrip("-*• ").strip()
        for line in sections.get("допущения", "").splitlines()
        if line.strip() and line.lstrip("-*• ").strip().lower() not in {"нет", "none", ""}
    ]
    conf_raw = sections.get("уверенность", "").lower()
    confidence = next((c for c in ("high", "medium", "low") if c in conf_raw), "low")
    return {
        "summary": sections.get("коротко", ""),
        "body": sections.get("черновик", text.strip()),
        "assumptions": assumptions,
        "confidence": confidence,
    }


class LLMAnswerer:
    def __init__(self, llm: LLM, kb: KnowledgeBase | None = None, effort: str = "high", web_search: bool = True,
                 title: str = "Встреча"):
        self.llm = llm
        self.kb = kb or KnowledgeBase()
        self.effort = effort
        self.web_search = web_search
        self.title = title

    def answer(self, item: Item, segments: list[Segment]) -> Answer:
        kb_text, kb_sources = knowledge_context(item, self.kb)
        label = "Вопрос" if item.kind == ItemKind.QUESTION else "Задача"
        prompt = (
            f"Встреча: {self.title}\n\n"
            f"Расшифровка (контекст):\n{transcript_context(item, segments) or '(нет)'}\n\n"
            f"Материалы компании:\n{kb_text or '(ничего релевантного не найдено)'}\n\n"
            f"{label}: {item.text}\n"
            + (f"Дословно: «{item.quote}» — {item.speaker or 'участник'}\n" if item.quote else "")
        )
        try:
            result = self.llm.research(ANSWER_SYSTEM, prompt, self.effort, self.web_search)
        except LLMError as exc:
            log.warning("answer failed for %s: %s", item.id, exc)
            return Answer(item_id=item.id, status=AnswerStatus.FAILED, summary="Не удалось подготовить ответ",
                          body=str(exc))
        fields = parse_answer_text(result.text)
        cited = set(re.findall(r"\[doc:([^\]]+)\]", result.text))
        sources = [s for s in kb_sources if s.ref[4:] in cited] + result.sources
        return Answer(item_id=item.id, status=AnswerStatus.DRAFT, sources=sources, **fields)
