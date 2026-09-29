import threading
import time

import pytest

from recapper.answer import LLMAnswerer, OfflineAnswerer
from recapper.config import Settings
from recapper.detect import HeuristicDetector, LLMDetector
from recapper.engine import Components, LiveSession, build_components, process_segments
from recapper.llm import ResearchResult
from recapper.models import AnswerStatus, ItemOrigin, Segment
from recapper.recap import HeuristicRecapper, LLMRecapper
from recapper.transcript import parse_transcript
from tests.fakes import GOOD_ANSWER, FakeLLM


def claude_components(llm, kb=None):
    return Components(LLMDetector(llm), LLMAnswerer(llm, kb), LLMRecapper(llm), "claude")


def offline_components(kb=None):
    return Components(HeuristicDetector(), OfflineAnswerer(kb), HeuristicRecapper(), "offline")


def test_build_components_offline_without_key(settings):
    assert build_components(settings).mode == "offline"


def test_build_components_claude_with_key(settings, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    c = build_components(settings)
    assert c.mode == "claude" and isinstance(c.detector, LLMDetector)
    assert c.answerer.effort == settings.answer_effort


def test_build_components_with_injected_llm(settings):
    assert build_components(settings, llm=FakeLLM()).mode == "claude"


def test_batch_offline_full_report(meeting_text, kb):
    report = process_segments(parse_transcript(meeting_text), offline_components(kb), title="Игра",
                              questions=["Какой бюджет на награды?", "  "])
    assert report.title == "Игра" and report.mode == "offline"
    assert len(report.items) >= 4
    assert report.items[-1].origin == ItemOrigin.USER
    assert {a.item_id for a in report.answers} == {i.id for i in report.items}
    assert all(a.status == AnswerStatus.NEEDS_LLM for a in report.answers)
    assert report.recap.action_items


def test_batch_claude_every_item_answered(meeting_text):
    llm = FakeLLM(detect=lambda p: {"items": [
        {"kind": "task", "text": "Дописать механику монетизации игры с покупкой в Купере", "quote": "", "speaker": "Аня"},
        {"kind": "question", "text": "Как считать конверсию из Самоката в Купер", "quote": "", "speaker": "Макс"},
    ]})
    report = process_segments(parse_transcript(meeting_text), claude_components(llm))
    assert len(report.items) == 2
    assert all(a.status == AnswerStatus.DRAFT for a in report.answers)
    assert report.recap.summary == "Обсудили игру."
    kinds = [k for k, _ in llm.calls]
    assert kinds.count("detect") == 1 and kinds.count("research") == 2 and kinds.count("recap") == 1


def test_live_batches_small_segments_until_threshold():
    llm = FakeLLM()
    s = LiveSession(claude_components(llm), min_chars=50)
    try:
        assert s.add_segments([Segment(text="короткая")]) == []
        assert not any(k == "detect" for k, _ in llm.calls)
        s.add_segments([Segment(text="x" * 60)])
        assert [k for k, _ in llm.calls].count("detect") == 1
        # Both segments were shown to the detector in one call.
        assert "короткая" in llm.calls[0][1]
    finally:
        s.close()


def test_live_context_and_events_and_finish():
    seen_prompts = []

    def detect(prompt):
        seen_prompts.append(prompt)
        if "конверсию" in prompt.split("СВЕЖИЙ фрагмент")[1]:
            return {"items": [{"kind": "question", "text": "Как считать конверсию в Купер", "quote": "конверсию",
                               "speaker": "Макс"}]}
        return {"items": []}

    s = LiveSession(claude_components(FakeLLM(detect=detect)), min_chars=0)
    s.add_segments([Segment(speaker="Аня", text="Обсуждаем игру в Самокате")])
    items = s.add_segments([Segment(speaker="Макс", text="Как будем считать конверсию?", start=40.0)])
    assert len(items) == 1 and items[0].start == 40.0
    assert "Обсуждаем игру" in seen_prompts[1].split("СВЕЖИЙ фрагмент")[0]  # previous context passed
    q = s.ask("Какие механики у конкурентов?")
    report = s.finish(timeout=5)
    assert s.finished and len(report.answers) == 2
    types = [e.type for e in s.events()]
    assert types.count("item") == 2 and types.count("answer") == 2 and types[-1] == "recap"
    seqs = [e.seq for e in s.events()]
    assert seqs == sorted(seqs) and s.events(since=seqs[-2])[0].seq == seqs[-1]
    assert report.answer_for(q.id) is not None
    with pytest.raises(RuntimeError):
        s.add_segments([Segment(text="после конца")])
    assert s.finish() is report  # idempotent


def test_live_duplicates_across_calls_are_dropped():
    item = {"kind": "task", "text": "Посчитать конверсию в Купер", "quote": "", "speaker": ""}
    s = LiveSession(claude_components(FakeLLM(detect=lambda p: {"items": [item]})), min_chars=0)
    s.add_segments([Segment(text="раз")])
    s.add_segments([Segment(text="два")])
    report = s.finish(timeout=5)
    assert len(report.items) == 1


def test_live_detector_crash_is_reported_not_raised():
    class Boom:
        def detect(self, *a):
            raise ValueError("bad detector")

    s = LiveSession(Components(Boom(), OfflineAnswerer(), HeuristicRecapper(), "offline"), min_chars=0)
    assert s.add_segments([Segment(text="что угодно тут")]) == []
    errors = [e for e in s.events() if e.type == "error"]
    assert errors and "bad detector" in errors[0].data["message"]
    s.finish(timeout=5)


def test_live_answerer_crash_becomes_failed_answer():
    class Boom:
        def answer(self, item, segments):
            raise RuntimeError("answer crash")

    s = LiveSession(Components(HeuristicDetector(), Boom(), HeuristicRecapper(), "offline"), min_chars=0)
    s.ask("Какая конверсия у промокодов?")
    report = s.finish(timeout=5)
    assert report.answers[0].status == AnswerStatus.FAILED and "answer crash" in report.answers[0].body


def test_live_recap_crash_reported():
    class Boom:
        def recap(self, segments):
            raise RuntimeError("recap crash")

    s = LiveSession(Components(HeuristicDetector(), OfflineAnswerer(), Boom(), "offline"))
    s.add_segments([Segment(text="текст")])
    s.finish(timeout=5)
    assert any(e.type == "error" and "recap crash" in e.data["message"] for e in s.events())


TOPICS = [
    "посчитать конверсию промокода", "собрать аналоги игровых механик", "оценить бюджет наград",
    "подготовить схему атрибуции", "нарисовать экран награды", "проверить deeplink в Купере",
    "сравнить удержание когорт", "написать текст пуша", "согласовать лимит с финансами",
    "найти юриста по акциям", "описать правила розыгрыша", "замерить нагрузку сервера",
    "выбрать поставщика подарков", "обновить FAQ поддержки", "запустить A/B тест",
    "проанализировать отток игроков", "составить план релиза", "починить баг таблицы лидеров",
    "перевести интерфейс на английский", "договориться с партнёрами о кобрендинге",
]


def test_live_concurrent_producers_do_not_lose_items():
    # Slow answers + many threads adding segments at once.
    def research(prompt):
        time.sleep(0.01)
        return ResearchResult(text=GOOD_ANSWER)

    counter = {"n": 0}
    lock = threading.Lock()

    def detect(prompt):
        with lock:
            counter["n"] += 1
            n = counter["n"]
        topic = TOPICS[(n - 1) % len(TOPICS)]
        return {"items": [{"kind": "task", "text": topic, "quote": "", "speaker": ""}]}

    s = LiveSession(claude_components(FakeLLM(detect=detect, research=research)), min_chars=0, max_workers=8)
    threads = [threading.Thread(target=s.add_segments, args=([Segment(text=f"реплика {i}")],)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    report = s.finish(timeout=10)
    assert len(report.segments) == 20
    assert len(report.items) == counter["n"]
    assert {a.item_id for a in report.answers} == {i.id for i in report.items}


def test_process_segments_with_settings_offline(meeting_text, settings):
    report = process_segments(parse_transcript(meeting_text), build_components(Settings()))
    assert report.items and report.mode == "offline"
