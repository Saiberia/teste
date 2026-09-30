"""Swappable AI providers and output interception.

- ``OpenAICompatLLM``: any OpenAI-compatible Chat Completions endpoint
  (OpenAI, local Ollama / LM Studio / vLLM, and hosted gateways that expose
  this API). No built-in web search: answers rely on meeting + company docs.
- ``TracingLLM``: wraps any provider, records every request/response to
  JSONL and audits it against the output contracts.
- ``make_llm``: picks the provider from settings.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .config import Settings
from .contracts import check_answer_text, extract_json, validate_schema
from .llm import LLM, ClaudeLLM, LLMError, ResearchResult


def _rejects_format(message: str) -> bool:
    """A 400/422 caused by the response_format (not e.g. context length).

    Proxies (Gemini, etc.) often translate the schema and fail with an unrelated
    message, so any 400/422 that is not about length counts as "try a simpler mode".
    """
    m = message.lower()
    if not ("provider error 400" in m or "provider error 422" in m):
        return False
    return not any(h in m for h in ("context", "too long", "maximum", "token"))


def normalize_base_url(url: str) -> str:
    """``http://host:8045`` -> ``http://host:8045/v1``; an explicit path is kept."""
    url = (url or "").strip().rstrip("/")
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    scheme, sep, rest = url.partition("://")
    if sep and "/" not in rest:
        url += "/v1"
    return url


class OpenAICompatLLM:
    def __init__(self, base_url: str, api_key: str = "", model: str = "gpt-4o-mini", timeout: float = 120.0,
                 transport: httpx.BaseTransport | None = None):
        self.base_url = normalize_base_url(base_url)
        self.model = model
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.Client(timeout=timeout, headers=headers, transport=transport)
        self._json_mode = "json_schema"  # downgraded automatically if the server rejects it
        self._mode_lock = threading.Lock()

    def _chat(self, system: str, prompt: str, response_format: dict | None) -> str:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        }
        if response_format:
            body["response_format"] = response_format
        try:
            resp = self._http.post(f"{self.base_url}/chat/completions", json=body)
        except httpx.HTTPError as exc:
            raise LLMError(f"cannot reach {self.base_url}: {exc}") from exc
        if resp.status_code >= 400:
            raise LLMError(f"provider error {resp.status_code}: {resp.text[:300]}")
        try:
            choice = resp.json()["choices"][0]
            content = choice["message"].get("content") or ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"unexpected provider response: {resp.text[:300]}") from exc
        if choice.get("finish_reason") == "length":
            raise LLMError("response was cut off (finish_reason=length)")
        return content

    def list_models(self) -> list[str]:
        try:
            resp = self._http.get(f"{self.base_url}/models")
        except httpx.HTTPError as exc:
            raise LLMError(f"cannot reach {self.base_url}: {exc}") from exc
        if resp.status_code >= 400:
            raise LLMError(f"provider error {resp.status_code}: {resp.text[:300]}")
        try:
            data = resp.json()
            rows = data.get("data", data.get("models", [])) if isinstance(data, dict) else data
            ids = [r.get("id") or r.get("name") if isinstance(r, dict) else r for r in rows]
        except (ValueError, AttributeError, TypeError) as exc:
            raise LLMError(f"unexpected /models response: {resp.text[:200]}") from exc
        return sorted({str(i) for i in ids if i})

    def ping(self) -> str:
        return self._chat("Reply with one word.", "Say OK.", None).strip()

    def json(self, system: str, prompt: str, schema: dict, effort: str = "low") -> dict:
        formats = {
            "json_schema": {"type": "json_schema", "json_schema": {"name": "output", "schema": schema, "strict": True}},
            "json_object": {"type": "json_object"},
            "none": None,
        }
        order = ["json_schema", "json_object", "none"]
        order = order[order.index(self._json_mode):]
        instruction = f"\n\nОтветь ТОЛЬКО JSON по схеме:\n{json.dumps(schema, ensure_ascii=False)}"
        last: Exception | None = None
        for mode in order:
            try:
                text = self._chat(system + instruction, prompt, formats[mode])
            except LLMError as exc:
                # 400 means "this server doesn't support that response_format": try a simpler one.
                if _rejects_format(str(exc)) and mode != "none":
                    with self._mode_lock:
                        self._json_mode = order[order.index(mode) + 1]
                    last = exc
                    continue
                raise
            try:
                data = extract_json(text)
            except ValueError as exc:
                raise LLMError(f"model did not return JSON: {text[:200]}") from exc
            if not isinstance(data, dict):
                raise LLMError("model returned JSON that is not an object")
            return data
        raise LLMError(f"provider rejected every JSON mode: {last}")

    def research(self, system: str, prompt: str, effort: str = "high", web_search: bool = True) -> ResearchResult:
        return ResearchResult(text=self._chat(system, prompt, None).strip())


@dataclass
class TraceRecord:
    ts: str
    provider: str
    method: str  # json | research
    task: str  # detect | recap | assist | answer | ...
    prompt: str
    output: Any
    error: str | None
    latency_ms: int
    issues: list[str] = field(default_factory=list)


class TracingLLM:
    """Intercepts every call: what we asked, what the model answered, what's wrong with it."""

    def __init__(self, inner: LLM, provider: str, path: Path | None = None, keep: int = 500):
        self.inner = inner
        self.provider = provider
        self.path = Path(path) if path else None
        self.keep = keep
        self.records: list[TraceRecord] = []
        self._lock = threading.Lock()

    def _save(self, rec: TraceRecord) -> None:
        with self._lock:
            self.records.append(rec)
            del self.records[:-self.keep]
            if self.path:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec.__dict__, ensure_ascii=False, default=str) + "\n")

    @staticmethod
    def _task(schema: dict | None) -> str:
        props = set((schema or {}).get("properties", {}))
        if "items" in props:
            return "detect"
        if "summary" in props and "decisions" in props:
            return "recap"
        return next(iter(sorted(props)), "json") if props else "answer"

    def json(self, system: str, prompt: str, schema: dict, effort: str) -> dict:
        start = time.monotonic()
        try:
            data = self.inner.json(system, prompt, schema, effort)
        except Exception as exc:
            self._save(TraceRecord(_now(), self.provider, "json", self._task(schema), prompt, None, str(exc),
                                   _ms(start), [f"error: {exc}"]))
            raise
        self._save(TraceRecord(_now(), self.provider, "json", self._task(schema), prompt, data, None, _ms(start),
                               validate_schema(data, schema)))
        return data

    def research(self, system: str, prompt: str, effort: str, web_search: bool) -> ResearchResult:
        start = time.monotonic()
        try:
            result = self.inner.research(system, prompt, effort, web_search)
        except Exception as exc:
            self._save(TraceRecord(_now(), self.provider, "research", "answer", prompt, None, str(exc), _ms(start),
                                   [f"error: {exc}"]))
            raise
        output = {"text": result.text, "sources": [s.model_dump() for s in result.sources]}
        self._save(TraceRecord(_now(), self.provider, "research", "answer", prompt, output, None, _ms(start),
                               check_answer_text(result.text, prompt)))
        return result


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def provider_name(settings: Settings) -> str:
    choice = settings.llm_provider
    if choice == "auto":
        if settings.has_claude:
            return "claude"
        if settings.openai_base_url:
            return "openai"
        return "none"
    return choice


def make_llm(settings: Settings) -> LLM | None:
    name = provider_name(settings)
    if name == "none":
        return None
    if name == "claude":
        inner: LLM = ClaudeLLM(model=settings.model, web_search_max_uses=settings.web_search_max_uses,
                               api_key=settings.anthropic_api_key or None)
    elif name == "openai":
        if not settings.openai_base_url:
            raise LLMError("RECAPPER_LLM=openai требует OPENAI_BASE_URL")
        inner = OpenAICompatLLM(settings.openai_base_url, settings.openai_api_key, settings.openai_model)
    else:
        from .simulate import SIMULATORS

        if name not in SIMULATORS:
            raise LLMError(f"неизвестный провайдер ИИ: {name}")
        inner = SIMULATORS[name]()
    return TracingLLM(inner, name, settings.trace_path)
