import anthropic
import httpx2
import pytest

from recapper.llm import FALLBACK_BETA, ClaudeLLM, LLMError, LLMRefusal, collect_sources
from tests.fakes import FakeAnthropic, message, search_blocks, text_block


def test_json_request_shape_and_parse():
    client = FakeAnthropic([message([text_block('{"items": []}')])])
    llm = ClaudeLLM(client=client)
    assert llm.json("sys", "prompt", {"type": "object"}, "low") == {"items": []}
    req = client.requests[0]
    assert req["model"] == "claude-opus-5-5"
    assert req["betas"] == [FALLBACK_BETA] and req["fallbacks"] == "default"
    assert req["output_config"]["effort"] == "low"
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "thinking" not in req  # Opus 5.5: thinking is always on, nothing to send


def test_json_errors():
    with pytest.raises(LLMError):
        ClaudeLLM(client=FakeAnthropic([message([text_block("not json")])])).json("s", "p", {}, "low")
    with pytest.raises(LLMError):
        ClaudeLLM(client=FakeAnthropic([message([])])).json("s", "p", {}, "low")
    with pytest.raises(LLMError, match="max_tokens"):
        ClaudeLLM(client=FakeAnthropic([message([text_block("{}")], "max_tokens")])).json("s", "p", {}, "low")


def test_refusal_is_raised_with_category():
    refused = message([], "refusal", {"type": "refusal", "category": "cyber", "explanation": "x"})
    with pytest.raises(LLMRefusal, match="cyber"):
        ClaudeLLM(client=FakeAnthropic([refused])).json("s", "p", {}, "low")


def test_api_errors_are_wrapped():
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    status = anthropic.RateLimitError("slow down", response=httpx2.Response(429, request=request), body=None)
    conn = anthropic.APIConnectionError(request=request)
    with pytest.raises(LLMError, match="429"):
        ClaudeLLM(client=FakeAnthropic([status])).json("s", "p", {}, "low")
    with pytest.raises(LLMError, match="reach"):
        ClaudeLLM(client=FakeAnthropic([conn])).json("s", "p", {}, "low")


def test_research_with_web_search_and_citations():
    cite = {"type": "web_search_result_location", "url": "https://b.example", "title": "B",
            "encrypted_index": "x", "cited_text": "c"}
    resp = message([*search_blocks(["https://a.example"]), text_block("Ответ", [cite])])
    client = FakeAnthropic([resp])
    result = ClaudeLLM(client=client, web_search_max_uses=3).research("s", "p", "high", True)
    assert result.text == "Ответ"
    assert [s.ref for s in result.sources] == ["https://a.example", "https://b.example"]
    tool = client.requests[0]["tools"][0]
    assert tool == {"type": "web_search_20260209", "name": "web_search", "max_uses": 3}


def test_research_without_web_search_sends_no_tools():
    client = FakeAnthropic([message([text_block("ok")])])
    ClaudeLLM(client=client).research("s", "p", "high", False)
    assert "tools" not in client.requests[0]


def test_research_resumes_after_pause_turn():
    paused = message([*search_blocks(["https://a.example"])], "pause_turn")
    done = message([*search_blocks(["https://c.example"], "srvtoolu_2"), text_block("Итог")])
    client = FakeAnthropic([paused, done])
    result = ClaudeLLM(client=client).research("s", "p", "high", True)
    assert result.text == "Итог"
    assert {s.ref for s in result.sources} == {"https://a.example", "https://c.example"}
    second = client.requests[1]["messages"]
    assert len(second) == 2 and second[1]["role"] == "assistant"  # no extra "continue" message


def test_research_gives_up_after_too_many_pauses():
    client = FakeAnthropic([message([], "pause_turn") for _ in range(10)])
    with pytest.raises(LLMError, match="continuations"):
        ClaudeLLM(client=client).research("s", "p", "high", True)


def test_collect_sources_ignores_error_result():
    error_result = {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1",
                    "content": {"type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"}}
    msg = message([{"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {}},
                   error_result, text_block("x")])
    assert collect_sources(msg.content) == []
