"""Simulated AI providers with distinct, realistic behaviours.

They exist to exercise the whole pipeline and the interception/contract
layer without API keys, and to show what happens when a weaker or sloppier
model is plugged in:

- ``sim-good``   follows every contract (like a strong model);
- ``sim-sloppy`` wraps JSON in prose and ``` fences, adds extra fields, uses
  bold labels instead of ``##`` headings, answers confidence in Russian and
  cites a document it was never given (a hallucinated source);
- ``sim-broken`` returns non-JSON, empty answers and intermittent errors.

Outputs are produced as raw text and parsed exactly like a real provider's.
"""

from __future__ import annotations

import itertools
import json
import re
import threading

from .contracts import extract_json
from .detect import HeuristicDetector
from .llm import LLMError, ResearchResult
from .recap import HeuristicRecapper
from .transcript import parse_transcript


def _between(text: str, start: str, end: str | None) -> str:
    i = text.find(start)
    if i == -1:
        return ""
    i += len(start)
    j = text.find(end, i) if end else -1
    return text[i:j if j != -1 else None].strip()


def _fill(schema: dict, hint: str) -> object:
    """Minimal instance of a JSON schema, used for tasks the simulator doesn't model."""
    t = schema.get("type")
    if "enum" in schema:
        return schema["enum"][0]
    if t == "object":
        return {k: _fill(v, hint) for k, v in schema.get("properties", {}).items()}
    if t == "array":
        return [_fill(schema.get("items", {"type": "string"}), hint)]
    if t in ("integer", "number"):
        return 1
    if t == "boolean":
        return True
    return hint


class SimulatedLLM:
    style = "good"

    def __init__(self) -> None:
        self._counter = itertools.count(1)
        self._lock = threading.Lock()

    def _n(self) -> int:
        with self._lock:
            return next(self._counter)

    # --- raw text a model would emit --------------------------------------------
    def _structured(self, prompt: str, schema: dict) -> dict:
        props = schema.get("properties", {})
        if "items" in props:  # detection
            fresh = _between(_between(prompt, "СВЕЖИЙ фрагмент:", "\n\nУже найденные пункты:"), "<transcript>", "</transcript>")
            items = HeuristicDetector().detect(parse_transcript(fresh), [], [])
            return {"items": [{"kind": i.kind.value, "text": i.text, "quote": i.quote, "speaker": i.speaker}
                              for i in items]}
        if "decisions" in props and "summary" in props:  # recap
            recap = HeuristicRecapper().recap(parse_transcript(_between(prompt, "<transcript>", "</transcript>")))
            data = recap.model_dump()
            data["summary"] = "Симуляция: " + data["summary"]
            return data
        if "bullets" in props:  # live assist: behave like the offline assistant on the given transcript
            from .assist import ASSIST_PROMPTS, Assistant

            action = next((k for k, v in ASSIST_PROMPTS.items() if v in prompt), "summary")
            segs = parse_transcript(_between(prompt, "<transcript>", "</transcript>"))
            result = Assistant._offline(action, segs) if segs else {"text": "Пока ничего не прозвучало.", "bullets": []}
            return {"text": "Симуляция: " + result["text"], "bullets": result["bullets"]}
        if "suggestions" in props:  # meeting chat
            question = prompt.rsplit("Вопрос:", 1)[-1].strip().splitlines()[0] if "Вопрос:" in prompt else ""
            return {"answer": f"Симуляция ответа на вопрос «{question}» по материалам встречи.",
                    "suggestions": ["Какие решения приняли?", "Кто за что отвечает?", "Что осталось открытым?"]}
        first_line = next((ln for ln in prompt.splitlines() if ln.strip()), "ответ")
        return _fill(schema, f"[симуляция] {first_line[:80]}")  # type: ignore[return-value]

    def _raw_json(self, prompt: str, schema: dict) -> str:
        return json.dumps(self._structured(prompt, schema), ensure_ascii=False)

    def _raw_answer(self, prompt: str) -> str:
        task = re.search(r"^(Вопрос|Задача): (.+)$", prompt, re.MULTILINE)
        subject = task.group(2) if task else "запрос"
        docs = re.findall(r"^\[doc:([^\]]+)\]", prompt, re.MULTILINE)
        cite = f" Опора: [doc:{docs[0]}]." if docs else ""
        return (
            f"## Коротко\nЧерновик по теме «{subject}».{cite}\n"
            "## Черновик\n1. Сформулировать цель и метрику.\n2. Предложить 2–3 варианта.\n3. Оценить риски.\n"
            "## Допущения\n- данные из встречи актуальны\n"
            "## Уверенность\nmedium"
        )

    # --- LLM protocol ------------------------------------------------------------------
    def json(self, system: str, prompt: str, schema: dict, effort: str = "low") -> dict:
        raw = self._raw_json(prompt, schema)
        try:
            data = extract_json(raw)
        except ValueError as exc:
            raise LLMError(f"model did not return JSON: {raw[:120]}") from exc
        if not isinstance(data, dict):
            raise LLMError("model returned JSON that is not an object")
        return data

    def research(self, system: str, prompt: str, effort: str = "high", web_search: bool = True) -> ResearchResult:
        return ResearchResult(text=self._raw_answer(prompt))


class SloppyLLM(SimulatedLLM):
    style = "sloppy"

    def _raw_json(self, prompt: str, schema: dict) -> str:
        data = self._structured(prompt, schema)
        for item in data.get("items", []) if isinstance(data, dict) else []:
            item["confidence"] = 0.9  # field the schema doesn't allow
        body = json.dumps(data, ensure_ascii=False, indent=2)
        return f"Конечно! Вот результат:\n```json\n{body}\n```\nНадеюсь, это поможет."

    def _raw_answer(self, prompt: str) -> str:
        task = re.search(r"^(Вопрос|Задача): (.+)$", prompt, re.MULTILINE)
        subject = task.group(2) if task else "запрос"
        return (
            f"**Коротко:** предлагаю решение по теме «{subject}».\n\n"
            "**Черновик:**\n- шаг 1\n- шаг 2 (см. [doc:secret_roadmap.md])\n\n"
            "**Допущения:**\n- рынок растёт на 40% в год\n\n"
            "**Уверенность:** средняя"
        )


class BrokenLLM(SimulatedLLM):
    style = "broken"

    def _raw_json(self, prompt: str, schema: dict) -> str:
        n = self._n()
        if n % 2:
            return "Извините, я не могу вывести JSON, но вот мысли: встреча была продуктивной."
        return '{"items": [{"kind": "idea", "text": 42}'  # truncated + wrong types

    def research(self, system: str, prompt: str, effort: str = "high", web_search: bool = True) -> ResearchResult:
        n = self._n()
        if n % 3 == 0:
            raise LLMError("provider error 503: overloaded")
        return ResearchResult(text="" if n % 3 == 1 else "ок")


SIMULATORS = {"sim-good": SimulatedLLM, "sim-sloppy": SloppyLLM, "sim-broken": BrokenLLM}
