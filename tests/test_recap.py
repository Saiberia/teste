from recapper.models import Segment
from recapper.recap import HeuristicRecapper, LLMRecapper
from recapper.transcript import parse_transcript
from tests.fakes import FakeLLM


def test_heuristic_recap_on_example(meeting_text):
    recap = HeuristicRecapper().recap(parse_transcript(meeting_text))
    assert any("промокод" in d for d in recap.decisions)
    owners = {a.owner: a for a in recap.action_items}
    assert owners["Макс"].due == "до пятницы"
    assert owners["Лена"].due == "к среде"
    assert "Аня" in recap.summary and "слышно" not in recap.summary


def test_heuristic_recap_empty():
    recap = HeuristicRecapper().recap([])
    assert recap.decisions == [] and recap.action_items == []


def test_llm_recap_validates_output():
    llm = FakeLLM(recap={"summary": "Итог", "decisions": ["A"], "action_items": [{"text": "x", "owner": "Макс", "due": ""}],
                         "sections": [{"title": "Гипотезы", "bullets": ["h1"]}]})
    recap = LLMRecapper(llm, template="product", language="en").recap([Segment(text="привет")])
    assert recap.summary == "Итог" and recap.action_items[0].owner == "Макс"
    assert recap.sections[0].title == "Гипотезы"
    prompt = llm.calls[0][1]
    assert "<transcript>" in prompt and "English" in prompt


def test_llm_recap_falls_back_on_error_and_bad_shape():
    segs = [Segment(speaker="Аня", text="Решили делать промокод.")]
    assert LLMRecapper(FakeLLM(fail={"recap"})).recap(segs).decisions == ["Решили делать промокод."]
    bad = FakeLLM(recap={"summary": 5, "decisions": "not a list", "action_items": []})
    assert LLMRecapper(bad).recap(segs).decisions == ["Решили делать промокод."]


def test_llm_recap_empty_no_call():
    llm = FakeLLM()
    assert LLMRecapper(llm).recap([]).summary == ""
    assert llm.calls == []


def test_heuristic_recap_ignores_negated_decisions_and_assistant_commands():
    segs = [Segment(speaker="Аня", text="Мы так и не решили, какой бюджет. Ассистент, посчитай бюджет наград.")]
    recap = HeuristicRecapper().recap(segs)
    assert recap.decisions == [] and recap.action_items == []
