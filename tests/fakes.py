"""Test doubles: a scripted LLM and a fake Anthropic client returning real SDK objects."""

from __future__ import annotations

import threading
from typing import Any, Callable

from anthropic.types.beta import BetaMessage

from recapper.answer import ANSWER_SYSTEM
from recapper.detect import DETECT_SYSTEM
from recapper.llm import LLMError, ResearchResult
from recapper.models import Source


class FakeLLM:
    """Implements the LLM protocol with deterministic, inspectable behaviour."""

    def __init__(self, detect: Callable[[str], dict] | None = None, recap: dict | None = None,
                 research: Callable[[str], ResearchResult] | None = None, fail: set[str] | None = None):
        self._detect = detect or (lambda prompt: {"items": []})
        self._recap = recap or {"summary": "Обсудили игру.", "decisions": [], "action_items": [], "sections": []}
        self._research = research or (lambda prompt: ResearchResult(text=GOOD_ANSWER, sources=[]))
        self.fail = fail or set()
        self.calls: list[tuple[str, str]] = []
        self._lock = threading.Lock()

    def json(self, system: str, prompt: str, schema: dict, effort: str) -> dict:
        props = schema.get("properties", {})
        kind = "detect" if system == DETECT_SYSTEM else "recap" if "decisions" in props else "assist" if "bullets" in props else "chat"
        with self._lock:
            self.calls.append((kind, prompt))
        if kind in self.fail:
            raise LLMError(f"{kind} boom")
        if kind == "assist":
            return {"text": "Итог от ИИ", "bullets": ["пункт"]}
        if kind == "chat":
            return {"answer": "Ответ по встрече", "suggestions": ["a?", "b?", "c?", "d?"]}
        return self._detect(prompt) if kind == "detect" else self._recap

    def research(self, system: str, prompt: str, effort: str, web_search: bool) -> ResearchResult:
        assert system == ANSWER_SYSTEM
        with self._lock:
            self.calls.append(("research", prompt))
        if "research" in self.fail:
            raise LLMError("research boom")
        return self._research(prompt)


GOOD_ANSWER = """## Коротко
Награда — промокод на первый заказ в Купере, атрибуция по уникальному коду.
## Черновик
1. Игрок проходит уровень и получает персональный промокод.
2. Опираемся на [doc:kuper_crosssell.md].
## Допущения
- конверсия активации 5%
- средний чек 1900 ₽
## Уверенность
medium"""


def web_source(n: int = 1) -> Source:
    return Source(title=f"Источник {n}", ref=f"https://example.com/{n}")


def message(content: list[dict], stop_reason: str = "end_turn", stop_details: dict | None = None) -> BetaMessage:
    data: dict[str, Any] = {
        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
        "stop_reason": stop_reason, "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 10}, "content": content,
    }
    if stop_details is not None:
        data["stop_details"] = stop_details
    return BetaMessage.model_validate(data)


def text_block(text: str, citations: list[dict] | None = None) -> dict:
    block: dict[str, Any] = {"type": "text", "text": text}
    if citations:
        block["citations"] = citations
    return block


def search_blocks(urls: list[str], tool_id: str = "srvtoolu_1") -> list[dict]:
    return [
        {"type": "server_tool_use", "id": tool_id, "name": "web_search", "input": {"query": "q"}},
        {"type": "web_search_tool_result", "tool_use_id": tool_id, "content": [
            {"type": "web_search_result", "url": u, "title": f"T {u}", "encrypted_content": "e", "page_age": None}
            for u in urls
        ]},
    ]


class _Messages:
    def __init__(self, responses: list[Any]):
        self.responses = list(responses)
        self.requests: list[dict] = []

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeAnthropic:
    """Mimics ``client.beta.messages.create`` only."""

    def __init__(self, responses: list[Any]):
        self.beta = type("Beta", (), {})()
        self.beta.messages = _Messages(responses)

    @property
    def requests(self) -> list[dict]:
        return self.beta.messages.requests
