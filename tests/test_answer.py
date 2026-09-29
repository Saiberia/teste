from recapper import answer as answer_mod
from recapper.answer import LLMAnswerer, OfflineAnswerer, parse_answer_text, transcript_context
from recapper.llm import ResearchResult
from recapper.models import AnswerStatus, Item, ItemKind, Segment
from recapper.transcript import parse_transcript
from tests.fakes import GOOD_ANSWER, FakeLLM, web_source

ITEM = Item(kind=ItemKind.TASK, text="Дописать механику монетизации игры с покупкой в Купере",
            quote="Нам надо дописать механику монетизации игры", speaker="Аня")


def test_parse_answer_text_full():
    f = parse_answer_text(GOOD_ANSWER)
    assert f["summary"].startswith("Награда")
    assert "Игрок проходит" in f["body"]
    assert f["assumptions"] == ["конверсия активации 5%", "средний чек 1900 ₽"]
    assert f["confidence"] == "medium"


def test_parse_answer_text_unstructured_and_none_assumptions():
    f = parse_answer_text("Просто текст\nвторая строка")
    assert f["summary"] == "Просто текст" and f["confidence"] == "low"
    f = parse_answer_text("## Коротко\nОк\n## Допущения\n- нет\n## Уверенность\nHIGH")
    assert f["assumptions"] == [] and f["confidence"] == "high" and f["body"]


def test_llm_answerer_builds_prompt_and_sources(kb, meeting_text):
    llm = FakeLLM(research=lambda p: ResearchResult(text=GOOD_ANSWER, sources=[web_source(1)]))
    ans = LLMAnswerer(llm, kb, title="Игра").answer(ITEM, parse_transcript(meeting_text))
    assert ans.status == AnswerStatus.DRAFT and ans.confidence == "medium"
    refs = [s.ref for s in ans.sources]
    # Only KB docs actually cited by the model are kept, plus web sources.
    assert "doc:kuper_crosssell.md" in refs and "https://example.com/1" in refs
    prompt = llm.calls[0][1]
    assert "Встреча: Игра" in prompt and "[doc:" in prompt and "Дословно" in prompt and "Задача:" in prompt


def test_llm_answerer_failure_returns_failed():
    ans = LLMAnswerer(FakeLLM(fail={"research"})).answer(ITEM, [])
    assert ans.status == AnswerStatus.FAILED and "boom" in ans.body


def test_offline_answerer_uses_kb(kb):
    ans = OfflineAnswerer(kb).answer(ITEM, [])
    assert ans.status == AnswerStatus.NEEDS_LLM
    assert "базе знаний" in ans.body and ans.sources


def test_offline_answerer_without_kb():
    ans = OfflineAnswerer().answer(ITEM, [])
    assert "ничего подходящего" in ans.body and ans.sources == []


def test_transcript_context_trims_long_transcripts(monkeypatch):
    monkeypatch.setattr(answer_mod, "MAX_TRANSCRIPT_CHARS", 200)
    segs = [Segment(text=f"реплика {i} " + "слово " * 10) for i in range(100)]
    segs[70] = Segment(text="Нам надо дописать механику монетизации игры сейчас")
    ctx = transcript_context(ITEM, segs)
    assert "монетизации" in ctx and "реплика 0 " not in ctx and ctx.startswith("…")
