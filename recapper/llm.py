"""Claude access layer.

Everything else talks to the ``LLM`` protocol, so tests and offline mode can
swap in another implementation without touching the pipeline.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

import anthropic

from .models import Source

log = logging.getLogger(__name__)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_CONTINUATIONS = 5


class LLMError(RuntimeError):
    """Any failure the pipeline should surface instead of crashing on."""


class LLMRefusal(LLMError):
    pass


@dataclass
class ResearchResult:
    text: str
    sources: list[Source] = field(default_factory=list)


class LLM(Protocol):
    def json(self, system: str, prompt: str, schema: dict, effort: str) -> dict: ...

    def research(self, system: str, prompt: str, effort: str, web_search: bool) -> ResearchResult: ...


def _check_stop(response: Any) -> None:
    if response.stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        category = getattr(details, "category", None) if details else None
        raise LLMRefusal(f"model declined the request (category: {category})")
    if response.stop_reason == "max_tokens":
        raise LLMError("response was cut off by max_tokens")


def _texts(content: list[Any]) -> list[Any]:
    return [b for b in content if getattr(b, "type", None) == "text"]


def collect_sources(content: list[Any]) -> list[Source]:
    """Web search results and text citations, deduplicated by URL."""
    seen: dict[str, Source] = {}
    for block in content:
        btype = getattr(block, "type", None)
        if btype == "web_search_tool_result" and isinstance(block.content, list):
            for result in block.content:
                url = getattr(result, "url", None)
                if url and url not in seen:
                    seen[url] = Source(title=getattr(result, "title", "") or url, ref=url)
        elif btype == "text":
            for cite in getattr(block, "citations", None) or []:
                url = getattr(cite, "url", None)
                if url and url not in seen:
                    seen[url] = Source(title=getattr(cite, "title", "") or url, ref=url)
    return list(seen.values())


class ClaudeLLM:
    def __init__(self, model: str = "claude-opus-5-5", client: Any | None = None, web_search_max_uses: int = 5):
        self.model = model
        self.client = client if client is not None else anthropic.Anthropic()
        self.web_search_max_uses = web_search_max_uses

    def _create(self, **kwargs: Any) -> Any:
        try:
            return self.client.beta.messages.create(
                model=self.model,
                max_tokens=16000,
                betas=[FALLBACK_BETA],
                fallbacks="default",
                **kwargs,
            )
        except anthropic.APIStatusError as exc:
            raise LLMError(f"Claude API error {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"cannot reach Claude API: {exc}") from exc

    def json(self, system: str, prompt: str, schema: dict, effort: str = "low") -> dict:
        response = self._create(
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
        _check_stop(response)
        texts = _texts(response.content)
        if not texts:
            raise LLMError("no text in structured response")
        try:
            return json.loads(texts[0].text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"invalid JSON from model: {exc}") from exc

    def research(self, system: str, prompt: str, effort: str = "high", web_search: bool = True) -> ResearchResult:
        tools = (
            [{"type": "web_search_20260209", "name": "web_search", "max_uses": self.web_search_max_uses}]
            if web_search
            else []
        )
        messages: list[dict] = [{"role": "user", "content": prompt}]
        all_content: list[Any] = []
        for _ in range(MAX_CONTINUATIONS + 1):
            kwargs: dict[str, Any] = {
                "system": system,
                "messages": messages,
                "output_config": {"effort": effort},
            }
            if tools:
                kwargs["tools"] = tools
            response = self._create(**kwargs)
            all_content.extend(response.content)
            if response.stop_reason != "pause_turn":
                _check_stop(response)
                break
            # Server tool loop hit its iteration cap: resend to resume.
            messages = [messages[0], {"role": "assistant", "content": response.content}]
        else:
            raise LLMError("web research did not finish after several continuations")
        final_text = "".join(b.text for b in _texts(response.content)).strip()
        if not final_text:
            final_text = "".join(b.text for b in _texts(all_content)).strip()
        return ResearchResult(text=final_text, sources=collect_sources(all_content))
