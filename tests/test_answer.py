from recapper import answer as answer_mod
from recapper.answer import LLMAnswerer, OfflineAnswerer, parse_answer_text, transcript_context
from recapper.llm import ResearchResult
from recapper.memory import MemoryHit
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
    assert ans.status == AnswerStatus.NEEDS_LLM and ans.summary == ""
    assert "Материалы компании" in ans.body and ans.sources


def test_offline_answerer_without_kb():
    ans = OfflineAnswerer().answer(ITEM, [])
    assert "Ничего подходящего" in ans.body and ans.sources == []


def test_offline_answerer_uses_memory_of_past_meetings():
    hit = MemoryHit("m1", "Прошлая встреча", "2026-09-01", "Решили считать атрибуцию по промокодам", 1.0)
    ans = OfflineAnswerer(memory=lambda q: [hit]).answer(ITEM, [])
    assert "Из прошлых встреч" in ans.body and ans.sources[0].ref == "meeting:m1"


def test_llm_answerer_uses_memory_and_flags_unknown_meeting_refs():
    hit = MemoryHit("m1", "Прошлая", "2026-09-01", "атрибуция по промокодам", 1.0)
    text = GOOD_ANSWER + "\nСм. [meeting:m1] и [meeting:zzz]"
    llm = FakeLLM(research=lambda p: ResearchResult(text=text))
    ans = LLMAnswerer(llm, memory=lambda q: [hit], language="en").answer(ITEM, [])
    prompt = llm.calls[0][1]
    assert "<past_meetings>" in prompt and "[meeting:m1]" in prompt and prompt.rstrip().endswith("English.")
    assert any(s.ref == "meeting:m1" for s in ans.sources)
    assert any("zzz" in w for w in ans.warnings)


def test_llm_answerer_empty_text_is_failed():
    ans = LLMAnswerer(FakeLLM(research=lambda p: ResearchResult(text="  "))).answer(ITEM, [])
    assert ans.status == AnswerStatus.FAILED and ans.warnings == ["empty answer"]


def test_parse_answer_does_not_treat_words_as_headers():
    f = parse_answer_text("## Коротко\nЧерновик по теме игры.\n## Черновик\nТело\n## Допущения\n- нет\n## Уверенность\nhigh")
    assert f["summary"] == "Черновик по теме игры." and f["body"] == "Тело" and f["confidence"] == "high"


def test_transcript_context_long_meeting_picks_relevant_and_recent(monkeypatch):
    monkeypatch.setattr(answer_mod, "MAX_TRANSCRIPT_CHARS", 3000)
    segs = [Segment(text=f"реплика {i} " + "обычный текст " * 5) for i in range(300)]
    segs[70] = Segment(text="Нам надо дописать механику монетизации игры сейчас")
    item = ITEM.model_copy(update={"quote": ""})  # typed question: no quote to anchor on
    ctx = transcript_context(item, segs)
    assert "монетизации" in ctx  # relevant window found by search, not by position
    assert "реплика 299" in ctx  # the latest speech is always included
    assert "реплика 0 " not in ctx and "…" in ctx and len(ctx) <= 3000
