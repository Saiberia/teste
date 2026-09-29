import threading
import time

import pytest

from recapper.answer import LLMAnswerer, OfflineAnswerer
from recapper.assist import Assistant
from recapper.config import Settings
from recapper.detect import CommandDetector, HeuristicDetector, LLMDetector
from recapper.engine import Components, LiveSession, Runtime, SessionClosed, build_components, process_segments
from recapper.llm import ResearchResult
from recapper.models import AnswerStatus, ItemOrigin, Segment
from recapper.recap import HeuristicRecapper, LLMRecapper
from recapper.store import ReportStore
from recapper.transcript import parse_transcript
from tests.fakes import GOOD_ANSWER, FakeLLM


def ai_components(llm, kb=None):
    return Components(LLMDetector(llm), LLMAnswerer(llm, kb), LLMRecapper(llm), "custom", llm)


def offline_components(kb=None):
    return Components(HeuristicDetector(), OfflineAnswerer(kb), HeuristicRecapper(), "offline")


CMD = "Ассистент, допиши механику монетизации игры для Купера."


def test_build_components_modes(settings, monkeypatch):
    assert build_components(settings).mode == "offline"
    assert build_components(settings, llm=FakeLLM()).mode == "custom"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    c = build_components(settings)
    assert c.mode == "claude" and isinstance(c.detector, LLMDetector)


def test_batch_offline_answers_only_commands(meeting_text, kb):
    report = process_segments(parse_transcript(meeting_text), offline_components(kb), title="Игра",
                              questions=["Какой бюджет на награды?", "  "])
    commands = [i for i in report.items if i.is_command]
    suggestions = [i for i in report.items if not i.is_command]
    assert len(commands) == 3  # two voice commands + one typed question
    assert {i.origin for i in commands} == {ItemOrigin.VOICE, ItemOrigin.USER}
    assert suggestions, "questions heard in the meeting are still surfaced"
    assert {a.item_id for a in report.answers} == {i.id for i in commands}
    assert all(a.status == AnswerStatus.NEEDS_LLM for a in report.answers)


def test_batch_answer_all(meeting_text):
    report = process_segments(parse_transcript(meeting_text), offline_components(), auto_answer="all")
    assert {a.item_id for a in report.answers} == {i.id for i in report.items}


def test_batch_with_ai_calls_budget(meeting_text):
    llm = FakeLLM(detect=lambda p: {"items": [
        {"kind": "question", "text": "Как считать конверсию из Самоката в Купер", "quote": "", "speaker": "Макс"}]})
    report = process_segments(parse_transcript(meeting_text), ai_components(llm))
    commands = [i for i in report.items if i.is_command]
    assert len(commands) == 2 and all(report.answer_for(i.id).status == AnswerStatus.DRAFT for i in commands)
    kinds = [k for k, _ in llm.calls]
    # One detection call per chunk, one research per voice command, one recap: no research for suggestions.
    assert kinds.count("detect") == 1 and kinds.count("research") == 2 and kinds.count("recap") == 1
    assert report.recap.summary == "Обсудили игру."


def test_commands_are_immediate_even_below_detection_threshold():
    llm = FakeLLM()
    s = LiveSession(ai_components(llm), min_chars=10_000)
    items = s.add_segments([Segment(speaker="Аня", text=CMD)])
    assert len(items) == 1 and items[0].origin == ItemOrigin.VOICE
    assert not any(k == "detect" for k, _ in llm.calls)  # suggestions wait for more speech
    report = s.finish(deadline=5)
    assert report.answer_for(items[0].id).status == AnswerStatus.DRAFT


def test_live_batches_detection_until_threshold():
    llm = FakeLLM()
    s = LiveSession(ai_components(llm), min_chars=50)
    try:
        assert s.add_segments([Segment(text="короткая")]) == []
        assert not any(k == "detect" for k, _ in llm.calls)
        s.add_segments([Segment(text="x" * 60)])
        assert [k for k, _ in llm.calls].count("detect") == 1
        assert "короткая" in llm.calls[0][1]
    finally:
        s.close()


def test_live_full_flow_events_and_lifecycle():
    prompts = []

    def detect(prompt):
        prompts.append(prompt)
        fresh = prompt.split("СВЕЖИЙ фрагмент")[1]
        if "конверсию" in fresh:
            return {"items": [{"kind": "question", "text": "Как считать конверсию в Купер", "quote": "конверсию",
                               "speaker": "Макс"}]}
        return {"items": []}

    s = LiveSession(ai_components(FakeLLM(detect=detect)), min_chars=0)
    s.add_segments([Segment(speaker="Аня", text="Обсуждаем игру в Самокате")])
    items = s.add_segments([Segment(speaker="Макс", text="Как будем считать конверсию?", start=40.0)])
    assert len(items) == 1 and items[0].start == 40.0
    assert "Обсуждаем игру" in prompts[1].split("СВЕЖИЙ фрагмент")[0]  # previous context passed
    suggestion = items[0]
    assert not any(e.type == "answer" for e in s.events())  # suggestions are not answered by default
    s.request_answer(suggestion.id)
    q = s.ask("Какие механики у конкурентов?")
    s.assist("summary")
    report = s.finish(deadline=5)
    assert s.finished and report.answer_for(q.id) and report.answer_for(suggestion.id)
    types = [e.type for e in s.events()]
    assert types.count("item") == 2 and types.count("answer") == 2 and "assist" in types
    assert types[-2:] == ["recap", "done"]
    seqs = [e.seq for e in s.events()]
    assert seqs == sorted(seqs) and s.events(since=seqs[-2])[0].seq == seqs[-1]
    with pytest.raises(SessionClosed):
        s.add_segments([Segment(text="после конца")])
    with pytest.raises(SessionClosed):
        s.ask("ещё вопрос?")
    assert s.finish() is report  # idempotent


def test_request_answer_unknown_item():
    s = LiveSession(offline_components())
    with pytest.raises(KeyError):
        s.request_answer("nope")
    s.finish(deadline=1)


def test_late_answers_after_deadline_are_marked_not_lost():
    release = threading.Event()

    def research(prompt):
        release.wait(5)
        return ResearchResult(text=GOOD_ANSWER)

    s = LiveSession(ai_components(FakeLLM(research=research)), min_chars=10_000)
    s.add_segments([Segment(text=CMD)])
    report = s.finish(deadline=0.2)
    release.set()
    assert report.answers[0].status == AnswerStatus.FAILED and "Не успело" in report.answers[0].summary
    time.sleep(0.1)
    assert len(report.answers) == 1  # the late result did not sneak into the sealed report


def test_concurrent_finish_runs_recap_once():
    s = LiveSession(offline_components())
    s.add_segments([Segment(text="Решили делать промокод.")])
    threads = [threading.Thread(target=s.finish) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [e.type for e in s.events()].count("recap") == 1


def test_detection_failure_retries_then_gives_up():
    llm = FakeLLM(fail={"detect"})
    s = LiveSession(ai_components(llm), min_chars=0)
    s.add_segments([Segment(text="Как поднять конверсию промокодов?")])
    errors = [e for e in s.events() if e.type == "error"]
    assert errors and errors[0].data["retry"] is True
    s.add_segments([Segment(text="ещё реплика")])
    assert "поднять конверсию" in llm.calls[-1][1]  # the failed chunk was retried with the new speech
    s.finish(deadline=5)
    assert [e for e in s.events() if e.type == "error"][-1].data["retry"] is False


def test_detector_crash_is_reported_not_raised():
    class Boom:
        def detect(self, *a):
            raise ValueError("bad detector")

    s = LiveSession(Components(Boom(), OfflineAnswerer(), HeuristicRecapper(), "offline"), min_chars=0)
    assert s.add_segments([Segment(text="что угодно тут")]) == []
    assert any(e.type == "error" and "bad detector" in e.data["message"] for e in s.events())
    s.finish(deadline=5)


def test_answerer_crash_becomes_failed_answer():
    class Boom:
        def answer(self, item, segments, progress=None):
            raise RuntimeError("answer crash")

    s = LiveSession(Components(HeuristicDetector(), Boom(), HeuristicRecapper(), "offline"), min_chars=0)
    s.ask("Какая конверсия у промокодов?")
    report = s.finish(deadline=5)
    assert report.answers[0].status == AnswerStatus.FAILED and "answer crash" in report.answers[0].body


def test_recap_crash_reported():
    class Boom:
        def recap(self, segments):
            raise RuntimeError("recap crash")

    s = LiveSession(Components(HeuristicDetector(), OfflineAnswerer(), Boom(), "offline"))
    s.add_segments([Segment(text="текст")])
    s.finish(deadline=5)
    assert any(e.type == "error" and "recap crash" in e.data["message"] for e in s.events())


def test_answer_limit():
    s = LiveSession(offline_components(), max_answers=2)
    for q in ("Первый вопрос про бюджет?", "Второй вопрос про конверсию?", "Третий вопрос про удержание?"):
        s.ask(q)
    report = s.finish(deadline=5)
    assert len(report.answers) == 2
    assert any(e.type == "limit" for e in s.events())


TOPICS = [
    "посчитай конверсию промокода", "собери аналоги игровых механик", "оцени бюджет наград",
    "подготовь схему атрибуции", "нарисуй экран награды", "проверь deeplink в Купере",
    "сравни удержание когорт", "напиши текст пуша", "согласуй лимит с финансами",
    "найди юриста по акциям", "опиши правила розыгрыша", "замерь нагрузку сервера",
    "выбери поставщика подарков", "обнови FAQ поддержки", "запусти A/B тест",
    "проанализируй отток игроков", "составь план релиза", "почини баг таблицы лидеров",
    "переведи интерфейс на английский", "договорись с партнёрами о кобрендинге",
]


def test_concurrent_producers_do_not_lose_items():
    def research(prompt):
        time.sleep(0.01)
        return ResearchResult(text=GOOD_ANSWER)

    s = LiveSession(ai_components(FakeLLM(research=research)), min_chars=10_000, max_workers=8)
    threads = [threading.Thread(target=s.add_segments, args=([Segment(text=f"Ассистент, {topic}")],))
               for topic in TOPICS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    report = s.finish(deadline=10)
    assert len(report.segments) == 20 and len(report.items) == 20
    assert {a.item_id for a in report.answers} == {i.id for i in report.items}
    assert all(a.status == AnswerStatus.DRAFT for a in report.answers)


# --- Runtime -----------------------------------------------------------------------


def test_runtime_applies_settings_live(tmp_path):
    store = ReportStore(tmp_path / "r.db")
    rt = Runtime(Settings(db_path=tmp_path / "r.db", llm_provider="none"), store)
    assert rt.mode == "offline" and rt.llm is None
    rt.apply_settings(Settings(db_path=tmp_path / "r.db", llm_provider="sim-good"))
    assert rt.mode == "sim-good" and rt.llm is not None
    rt.apply_settings(Settings(db_path=tmp_path / "r.db", llm_provider="openai"))  # no URL -> offline with reason
    assert rt.mode == "offline" and "OPENAI_BASE_URL" in rt.llm_error


def test_runtime_session_uses_settings(tmp_path):
    rt = Runtime(Settings(db_path=tmp_path / "r.db", llm_provider="sim-good", wake_words="бот",
                          suggestions_enabled=False, auto_answer="all", max_answers=7, answer_language="en"),
                 ReportStore(tmp_path / "r.db"))
    s = rt.session("Встреча", "web")
    assert s.c.detector is None and s.auto_answer == "all" and s.max_answers == 7
    assert s.c.answerer.language == "en" and isinstance(s.c.commands, CommandDetector)
    assert s.add_segments([Segment(text="Ассистент, посчитай бюджет")], flush=True) == []
    assert len(s.add_segments([Segment(text="Бот, посчитай бюджет наград")])) == 1
    s.finish(deadline=5)
    assert isinstance(s.c.assistant, Assistant)


def test_stage_events_cancel_dismiss_retry_refine():
    s = LiveSession(ai_components(FakeLLM()), min_chars=0)
    cmd = s.add_segments([Segment(text=CMD)])[0]
    s.finish_wait = None
    deadline = time.time() + 5
    while not any(e.type == "answer" for e in s.events()) and time.time() < deadline:
        time.sleep(0.02)
    stages = [e.data["stage"] for e in s.events() if e.type == "stage" and e.data["item_id"] == cmd.id]
    assert stages[:2] == ["understood", "memory"] and "web" in stages
    # Retry a finished answer.
    s.request_answer(cmd.id)
    # Refine: a follow-up answered with the previous answer as context.
    child = s.refine(cmd.id, "А если бюджет 100 тысяч?")
    assert child.parent_id == cmd.id and "Уточнение к задаче" in child.quote
    # Cancel a false trigger: its answer disappears and a late answer is discarded.
    s.set_item_status(cmd.id, "cancelled")
    report = s.finish(deadline=5)
    assert report.item(cmd.id).status == "cancelled" and report.answer_for(cmd.id) is None
    assert report.answer_for(child.id) is not None
    with pytest.raises(ValueError):
        s.set_item_status(cmd.id, "weird")
