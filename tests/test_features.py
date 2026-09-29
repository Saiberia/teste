"""Settings, Live Assist, meeting chat, memory, evaluation, i18n."""

import json

import pytest

from recapper.assist import ASSIST_ACTIONS, TEMPLATES, Assistant, template_of
from recapper.config import Settings
from recapper.evaluate import Scenario, format_results, run_eval
from recapper.i18n import language_instruction, t
from recapper.memory import MeetingMemory, report_chunks
from recapper.models import Answer, Item, ItemKind, MeetingReport, Recap, Segment
from recapper.prefs import (FIELDS, PrefsStore, SettingsError, apply_prefs, public_values, schema,
                            validate_update)
from recapper.store import ReportStore
from recapper.transcript import parse_transcript
from tests.conftest import EXAMPLES
from tests.fakes import FakeLLM

# --- settings ------------------------------------------------------------------


def test_every_setting_maps_to_a_config_field():
    for f in FIELDS:
        assert hasattr(Settings(), f.key), f.key
    keys = [f.key for f in FIELDS]
    assert len(keys) == len(set(keys))


def test_schema_is_bilingual_and_complete():
    sch = schema()
    assert all(f["label"]["ru"] and f["label"]["en"] for f in sch)
    tpl = next(f for f in sch if f["key"] == "default_template")
    assert len(tpl["options"]) == 11 == len(TEMPLATES)
    assert next(f for f in sch if f["key"] == "whisper_model")["restart"] is True


@pytest.mark.parametrize("values,error", [
    ({"nope": 1}, "неизвестная"),
    ({"web_search": "yes"}, "true/false"),
    ({"max_answers": 0}, "допустимо"),
    ({"max_answers": 1.5, "x": 1}, None),  # checked below separately
    ({"ui_language": "de"}, "допустимые"),
    ({"assist_actions": ["catch_up", "dance"]}, "допустимые"),
    ({"wake_words": " , "}, "хотя бы одно"),
    ({"openai_base_url": "ftp://x"}, "http"),
    ({"me_label": "x" * 600}, "длинное"),
])
def test_validate_update_rejects_bad_values(values, error):
    if error is None:
        with pytest.raises(SettingsError):
            validate_update(values)
        return
    with pytest.raises(SettingsError, match=error):
        validate_update(values)


def test_validate_update_coerces_and_resets():
    clean = validate_update({"max_answers": 12.0, "assist_actions": ["summary", "summary"], "web_search": None,
                             "wake_words": " бот, ассистент "})
    assert clean == {"max_answers": 12, "assist_actions": ["summary"], "web_search": None,
                     "wake_words": "бот, ассистент"}


def test_prefs_roundtrip_and_secrets_are_write_only(tmp_path):
    store = PrefsStore(tmp_path / "p.db")
    store.save({"ui_language": "en", "anthropic_api_key": "sk-secret", "max_answers": 5})
    store.save({"max_answers": None})  # reset
    loaded = store.load()
    assert loaded == {"ui_language": "en", "anthropic_api_key": "sk-secret"}
    settings = apply_prefs(Settings(), loaded)
    assert settings.ui_language == "en" and settings.has_claude
    public = public_values(settings)
    assert public["anthropic_api_key"] == {"set": True}
    assert "sk-secret" not in json.dumps(public)


def test_wake_word_list_adds_asr_misspelling():
    assert Settings(wake_words="Ассистент, Бот").wake_word_list == ("ассистент", "бот", "асистент")
    assert Settings(meeting_language="auto").whisper_language == ""


# --- live assist ------------------------------------------------------------------------

SEGS = parse_transcript((EXAMPLES / "meeting_samokat_kuper.txt").read_text("utf-8"))


@pytest.mark.parametrize("action", list(ASSIST_ACTIONS))
def test_assist_offline_actions(action):
    result = Assistant(None).run(action, SEGS)
    assert result["source"] == "offline" and result["title"] == ASSIST_ACTIONS[action]
    assert isinstance(result["bullets"], list)


def test_assist_offline_content():
    assert any("Макс" in b for b in Assistant().run("actions", SEGS)["bullets"])
    catch_up = Assistant().run("catch_up", SEGS, minutes=0.5)["bullets"]
    assert catch_up and all("00:0" not in b for b in catch_up) and "на этом всё" in catch_up[-1]
    assert Assistant().run("followups", SEGS)["bullets"]
    assert Assistant().run("summary", [])["source"] == "none"
    with pytest.raises(ValueError):
        Assistant().run("dance", SEGS)


def test_assist_with_ai_and_fallback():
    llm = FakeLLM()
    result = Assistant(llm, language="en").run("summary", SEGS)
    assert result == {"title": ASSIST_ACTIONS["summary"], "text": "Итог от ИИ", "bullets": ["пункт"], "source": "ai"}
    assert "English" in llm.calls[0][1] and "<transcript>" in llm.calls[0][1]
    broken = FakeLLM(fail={"assist"})
    assert Assistant(broken).run("summary", SEGS)["source"] == "offline"


def test_chat_ai_returns_three_suggestions_and_offline_fallback():
    report = MeetingReport(title="Игра", segments=SEGS,
                           items=[Item(kind=ItemKind.QUESTION, text="Как считать конверсию?")])
    ai = Assistant(FakeLLM()).chat("Что решили?", report)
    assert ai["answer"] == "Ответ по встрече" and len(ai["suggestions"]) == 3 and ai["source"] == "ai"
    off = Assistant(None).chat("Что решили про промокод?", report, past="[meeting:x] прошлое")
    assert "промокод" in off["answer"] and "прошлых встреч" in off["answer"] and len(off["suggestions"]) == 3


def test_templates():
    assert template_of("product").sections[0] == "Гипотезы"
    assert template_of("unknown").id == "general"


# --- memory --------------------------------------------------------------------------------


def test_memory_finds_earlier_meeting(tmp_path):
    store = ReportStore(tmp_path / "m.db")
    old = MeetingReport(title="Атрибуция", segments=[Segment(speaker="Лена", text="Решили считать атрибуцию по уникальным промокодам.")])
    other = MeetingReport(title="Найм", segments=[Segment(text="Обсуждали найм дизайнера.")])
    store.save(old, owner="web")
    store.save(other, owner="web")
    store.save(MeetingReport(title="Чужая", segments=[Segment(text="атрибуция промокоды секрет")]), owner="tg:1")
    hits = MeetingMemory(store, "web").search("как мы считаем атрибуцию промокодов")
    assert hits and hits[0].meeting_id == old.id and hits[0].ref == f"meeting:{old.id}"
    assert all(h.title != "Чужая" for h in hits)  # owners never see each other's meetings
    assert MeetingMemory(store, "web").search("атрибуция", exclude_id=old.id) == [] or \
        all(h.meeting_id != old.id for h in MeetingMemory(store, "web").search("атрибуция", exclude_id=old.id))


def test_report_chunks_include_answers_and_recap():
    item = Item(kind=ItemKind.TASK, text="Посчитать бюджет")
    report = MeetingReport(segments=[Segment(text=f"реплика {i}") for i in range(10)], items=[item],
                           answers=[Answer(item_id=item.id, summary="45 ₽ на игрока")],
                           recap=Recap(summary="Итог", decisions=["Промокод"]))
    chunks = report_chunks(report)
    assert any("45 ₽ на игрока" in c for c in chunks) and any("Промокод" in c for c in chunks)
    assert any("реплика 9" in c for c in chunks)


def test_store_retention(tmp_path):
    store = ReportStore(tmp_path / "r.db")
    store.save(MeetingReport(title="a"), owner="web")
    store._conn.execute("UPDATE reports SET created_at = '2000-01-01T00:00:00+00:00'")
    store.save(MeetingReport(title="b"), owner="web")
    assert store.purge_older_than(0) == 0
    assert store.purge_older_than(30) == 1 and [r["title"] for r in store.list("web")] == ["b"]


# --- evaluation ---------------------------------------------------------------------------


def test_eval_scores_providers(tmp_path):
    results = {p: run_eval(Settings(llm_provider=p), EXAMPLES / "eval", EXAMPLES / "knowledge", tmp_path / p)
               for p in ("sim-good", "sim-sloppy", "sim-broken", "none")}
    assert all(r.passed for r in results["sim-good"])
    assert all(r.commands_found == r.commands_expected for r in results["sim-sloppy"])
    assert not any(r.passed for r in results["sim-sloppy"])  # hallucinated sources fail the run
    assert not any(r.passed for r in results["sim-broken"])
    assert all(r.commands_found == r.commands_expected for r in results["sim-broken"])  # commands need no AI
    assert all(r.answers_draft == 0 for r in results["none"])
    assert (tmp_path / "sim-good" / "trace.jsonl").exists()
    text = format_results(results["sim-sloppy"], "sim-sloppy")
    assert "hallucinated" in text and "❌" in text


def test_scenario_forbid_and_mentions(tmp_path):
    scenario = Scenario(name="x", transcript="Аня: Ассистент, посчитай бюджет наград.\nЛена: смотрела сериал вчера вечером?",
                        expect_commands=[["бюджет"]], forbid=["сериал"], answer_should_mention=["промокод"])
    path = tmp_path / "s" / "a.json"
    path.parent.mkdir()
    path.write_text(json.dumps(scenario.__dict__, ensure_ascii=False), "utf-8")
    [result] = run_eval(Settings(llm_provider="none"), path.parent, None, tmp_path / "w")
    assert result.forbidden_hits == ["сериал"] and result.mentions_missing == ["промокод"]


# --- i18n -----------------------------------------------------------------------------------


def test_i18n():
    assert t("recap", "en") == "Summary" and t("recap", "de") == "Итог" and t("missing-key") == "missing-key"
    assert t("bot_deleted", "ru", n=3) == "Удалено встреч: 3."
    assert language_instruction("en").endswith("English.") and "русский" in language_instruction("ru")
    assert "встречи" in language_instruction("auto")
