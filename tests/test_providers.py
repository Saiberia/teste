"""Swappable providers, interception and contracts."""

import json

import httpx
import pytest

from recapper.answer import ANSWER_SYSTEM, parse_answer_text
from recapper.config import Settings
from recapper.contracts import check_answer_text, extract_json, validate_schema
from recapper.detect import DETECT_SCHEMA, DETECT_SYSTEM
from recapper.engine import build_components, process_segments
from recapper.llm import LLMError, ResearchResult
from recapper.models import AnswerStatus
from recapper.providers import OpenAICompatLLM, TracingLLM, make_llm, provider_name
from recapper.recap import RECAP_SCHEMA
from recapper.simulate import BrokenLLM, SimulatedLLM, SloppyLLM
from recapper.transcript import parse_transcript
from tests.fakes import GOOD_ANSWER, FakeLLM

# --- contracts --------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ('{"a": 1}', {"a": 1}),
    ('Вот:\n```json\n{"a": [1, 2]}\n```\nГотово', {"a": [1, 2]}),
    ('Результат: {"a": "скобка } внутри"} конец', {"a": "скобка } внутри"}),
    ('prefix {broken {"a": 2}', {"a": 2}),
    ('[1, 2]', [1, 2]),
])
def test_extract_json(raw, expected):
    assert extract_json(raw) == expected


def test_extract_json_fails_cleanly():
    with pytest.raises(ValueError):
        extract_json("нет тут JSON")


def test_validate_schema():
    ok = {"items": [{"kind": "task", "text": "t", "quote": "q", "speaker": ""}]}
    assert validate_schema(ok, DETECT_SCHEMA) == []
    bad = {"items": [{"kind": "idea", "text": 42, "extra": 1}]}
    issues = validate_schema(bad, DETECT_SCHEMA)
    assert any("not in" in i for i in issues) and any("expected string" in i for i in issues)
    assert any("missing" in i for i in issues) and any("unexpected field" in i for i in issues)
    assert validate_schema([], {"type": "object"}) == ["$: expected object, got list"]
    assert validate_schema(True, {"type": "integer"})  # bool is not an int
    assert validate_schema(1.5, {"type": "number"}) == []


def test_check_answer_text():
    prompt = "Материалы:\n[doc:kuper_crosssell.md]\n..."
    assert check_answer_text(GOOD_ANSWER, prompt) == []
    issues = check_answer_text("**Коротко:** x [doc:secret.md]\n## Уверенность\nсредняя", prompt)
    assert any("Черновик" in i for i in issues)
    assert any("secret.md" in i for i in issues)
    assert any("confidence" in i for i in issues)
    assert check_answer_text("  ") == ["empty answer"]


def test_parse_answer_text_accepts_bold_labels_and_russian_confidence():
    f = parse_answer_text(SloppyLLM()._raw_answer("Вопрос: как считать конверсию"))
    assert f["summary"].startswith("предлагаю") and "шаг 1" in f["body"]
    assert f["assumptions"] == ["рынок растёт на 40% в год"] and f["confidence"] == "medium"


# --- OpenAI-compatible provider ----------------------------------------------


def _transport(handler):
    return httpx.MockTransport(handler)


def test_openai_compat_json_schema_mode():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer k"
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"items": []}'}, "finish_reason": "stop"}]})

    llm = OpenAICompatLLM("http://local/v1/", "k", "m", transport=_transport(handler))
    assert llm.json("sys", "p", DETECT_SCHEMA) == {"items": []}
    assert seen[0]["response_format"]["type"] == "json_schema" and seen[0]["model"] == "m"
    assert "Ответь ТОЛЬКО JSON" in seen[0]["messages"][0]["content"]


def test_openai_compat_downgrades_json_mode_on_400():
    modes = []

    def handler(request):
        fmt = json.loads(request.content).get("response_format")
        modes.append(fmt["type"] if fmt else None)
        if fmt:
            return httpx.Response(400, text="response_format not supported")
        return httpx.Response(200, json={"choices": [{"message": {"content": "```json\n{\"a\": 1}\n```"}}]})

    llm = OpenAICompatLLM("http://x/v1", transport=_transport(handler))
    assert llm.json("s", "p", {"type": "object"}) == {"a": 1}
    assert modes == ["json_schema", "json_object", None]
    llm.json("s", "p", {"type": "object"})
    assert modes[-1] is None  # remembers the working mode


@pytest.mark.parametrize("response,match", [
    (httpx.Response(500, text="boom"), "500"),
    (httpx.Response(200, json={"choices": []}), "unexpected"),
    (httpx.Response(200, text="not json"), "unexpected"),
    (httpx.Response(200, json={"choices": [{"message": {"content": "x"}, "finish_reason": "length"}]}), "cut off"),
    (httpx.Response(200, json={"choices": [{"message": {"content": "no json here"}}]}), "did not return JSON"),
])
def test_openai_compat_errors(response, match):
    llm = OpenAICompatLLM("http://x", transport=_transport(lambda r: response))
    with pytest.raises(LLMError, match=match):
        llm.json("s", "p", {"type": "object"})


def test_openai_compat_network_error_and_research():
    def boom(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(LLMError, match="reach"):
        OpenAICompatLLM("http://x", transport=_transport(boom)).research("s", "p")
    ok = OpenAICompatLLM("http://x", transport=_transport(
        lambda r: httpx.Response(200, json={"choices": [{"message": {"content": " текст "}}]})))
    assert ok.research("s", "p").text == "текст"


# --- tracing / interception -------------------------------------------------------


def test_tracing_records_and_audits(tmp_path):
    path = tmp_path / "trace.jsonl"
    llm = TracingLLM(FakeLLM(detect=lambda p: {"items": [{"kind": "idea", "text": "x", "quote": "", "speaker": ""}]}),
                     "fake", path)
    llm.json(DETECT_SYSTEM, "p", DETECT_SCHEMA, "low")
    llm.research(ANSWER_SYSTEM, "Материалы [doc:a.md]", "high", False)
    lines = [json.loads(line) for line in path.read_text("utf-8").splitlines()]
    assert [r["task"] for r in lines] == ["detect", "answer"]
    assert any("not in" in i for i in lines[0]["issues"])
    assert lines[1]["issues"] == ["cites unknown document [doc:kuper_crosssell.md] (hallucinated source)"]
    assert all(r["latency_ms"] >= 0 and r["provider"] == "fake" for r in lines)


def test_tracing_records_errors_and_reraises():
    llm = TracingLLM(FakeLLM(fail={"recap", "research"}), "fake")
    with pytest.raises(LLMError):
        llm.json("sys", "p", RECAP_SCHEMA, "low")
    with pytest.raises(LLMError):
        llm.research(ANSWER_SYSTEM, "p", "high", True)
    assert [r.error for r in llm.records] == ["recap boom", "research boom"]
    assert llm.records[0].task == "recap"


def test_tracing_keeps_bounded_history():
    llm = TracingLLM(FakeLLM(), "fake", keep=3)
    for _ in range(5):
        llm.research(ANSWER_SYSTEM, "p", "high", False)
    assert len(llm.records) == 3


# --- provider selection ------------------------------------------------------------


def test_provider_selection(monkeypatch):
    assert provider_name(Settings()) == "none" and make_llm(Settings()) is None
    assert provider_name(Settings(openai_base_url="http://x")) == "openai"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    assert provider_name(Settings(openai_base_url="http://x")) == "claude"
    assert isinstance(make_llm(Settings()), TracingLLM)
    assert provider_name(Settings(llm_provider="none")) == "none"
    with pytest.raises(LLMError, match="OPENAI_BASE_URL"):
        make_llm(Settings(llm_provider="openai"))
    with pytest.raises(LLMError, match="неизвестный"):
        make_llm(Settings(llm_provider="magic"))
    assert isinstance(make_llm(Settings(llm_provider="openai", openai_base_url="http://x")).inner, OpenAICompatLLM)


# --- whole pipeline with each simulated AI ------------------------------------------


def run_with(provider, meeting_text, kb, tmp_path):
    settings = Settings(llm_provider=provider, trace_path=tmp_path / f"{provider}.jsonl")
    components = build_components(settings, kb=kb)
    report = process_segments(parse_transcript(meeting_text), components, questions=["Какой бюджет на награды?"])
    return report, components.llm.records


def test_pipeline_with_good_ai(meeting_text, kb, tmp_path):
    report, records = run_with("sim-good", meeting_text, kb, tmp_path)
    assert report.mode == "sim-good"
    assert any("монетизации" in i.text for i in report.items)
    assert all(a.status == AnswerStatus.DRAFT and not a.warnings for a in report.answers)
    assert report.recap.summary.startswith("Симуляция")
    assert all(r.issues == [] for r in records), [r.issues for r in records if r.issues]
    assert (tmp_path / "sim-good.jsonl").exists()


def test_pipeline_with_sloppy_ai_still_works_and_flags_problems(meeting_text, kb, tmp_path):
    report, records = run_with("sim-sloppy", meeting_text, kb, tmp_path)
    assert any("монетизации" in i.text for i in report.items)  # fenced JSON parsed
    drafts = [a for a in report.answers if a.status == AnswerStatus.DRAFT]
    assert drafts and all(a.confidence == "medium" for a in drafts)
    assert all(any("secret_roadmap.md" in w for w in a.warnings) for a in drafts)
    assert all(not any(s.ref == "doc:secret_roadmap.md" for s in a.sources) for a in drafts)
    detect_issues = [i for r in records if r.task == "detect" for i in r.issues]
    assert any("unexpected field" in i for i in detect_issues)


def test_pipeline_with_broken_ai_degrades_gracefully(meeting_text, kb, tmp_path):
    report, records = run_with("sim-broken", meeting_text, kb, tmp_path)
    # Voice commands don't depend on the model, so the user's tasks are still captured.
    commands = [i for i in report.items if i.is_command]
    assert len(commands) == 3
    assert {a.item_id for a in report.answers} == {i.id for i in commands}
    assert any(a.status == AnswerStatus.FAILED for a in report.answers)
    assert report.recap.summary  # heuristic recap after the model failed
    assert any(r.error for r in records)


def test_simulators_emit_distinct_raw_outputs():
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    assert SimulatedLLM().json("s", "p", schema) == {"x": "[симуляция] p"}
    assert SloppyLLM()._raw_json("p", schema).startswith("Конечно!")
    broken = BrokenLLM()
    with pytest.raises(LLMError):
        broken.json("s", "p", schema)
    # Second call: truncated JSON whose inner object parses but violates the schema.
    assert validate_schema(broken.json("s", "p", DETECT_SCHEMA), DETECT_SCHEMA)
    assert isinstance(SimulatedLLM().research("s", "Задача: X").text, str)
    assert ResearchResult("x").sources == []
