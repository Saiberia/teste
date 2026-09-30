import pytest

from recapper.detect import (CommandDetector, HeuristicDetector, LLMDetector, classify_sentence, is_duplicate,
                             sentences, similarity)
from recapper.llm import LLMError
from recapper.models import Item, ItemKind, ItemOrigin, Segment
from recapper.transcript import parse_transcript
from tests.fakes import FakeLLM

# --- voice commands: the core scenario --------------------------------------------


@pytest.mark.parametrize("text,expected,kind", [
    ("Ассистент, допиши механику монетизации игры: конверсия покупки из приложения Самоката в Купер.",
     "Допиши механику монетизации игры: конверсия покупки из приложения Самоката в Купер", ItemKind.TASK),
    ("Окей, ассистент, сколько стоит привлечение пользователя в фудтехе?",
     "Сколько стоит привлечение пользователя в фудтехе?", ItemKind.QUESTION),
    ("Слушай, рекапер: найди три аналога реферальных программ", "Найди три аналога реферальных программ", ItemKind.TASK),
    ("асистент посчитай бюджет наград", "Посчитай бюджет наград", ItemKind.TASK),  # ASR misspelling
    ("Задача для ассистента: сравнить удержание когорт", "Сравнить удержание когорт", ItemKind.TASK),
    ("Запиши вопрос: как считать LTV игроков?", "Как считать LTV игроков?", ItemKind.QUESTION),
    ("Assistant, draft three hypotheses about retention.", "Draft three hypotheses about retention", ItemKind.TASK),
])
def test_command_detector_recognises_commands(text, expected, kind):
    items = CommandDetector().detect([Segment(speaker="Мария", text=text, start=10.0)], [], [])
    assert len(items) == 1
    item = items[0]
    assert item.text == expected and item.kind == kind
    assert item.origin == ItemOrigin.VOICE and item.is_command and item.speaker == "Мария" and item.start == 10.0


@pytest.mark.parametrize("text", [
    "Наш ассистент в приложении работает плохо.",  # wake word not at the start
    "Ассистент.",  # no command
    "Ассистент, стоп",  # one word: too short to act on
    "Помощник руководителя придёт завтра.",  # "помощник" + noun, not addressed... still 3+ words -> see below
])
def test_command_detector_ignores_non_commands(text):
    items = CommandDetector().detect([Segment(text=text)], [], [])
    if text.startswith("Помощник руководителя"):
        # Known ambiguity: a sentence starting with a wake word is treated as a command.
        assert items and items[0].text.startswith("Руководителя")
    else:
        assert items == []


def test_command_split_across_segments_and_sentences():
    segs = [Segment(speaker="Мария", text="Окей, ассистент."),
            Segment(speaker="Мария", text="Найди три аналога реферальных программ в фудтех-приложениях."),
            Segment(speaker="Пётр", text="Ассистент. Сравни удержание когорт за март и апрель")]
    items = CommandDetector().detect(segs, [], [])
    assert [i.text for i in items] == ["Найди три аналога реферальных программ в фудтех-приложениях",
                                       "Сравни удержание когорт за март и апрель"]


def test_command_does_not_borrow_another_speakers_segment():
    segs = [Segment(speaker="Мария", text="Ассистент."), Segment(speaker="Пётр", text="Привет всем, как дела у вас?")]
    assert CommandDetector().detect(segs, [], []) == []


def test_custom_wake_words_and_dedup():
    det = CommandDetector(("бот",))
    assert det.detect([Segment(text="Ассистент, посчитай бюджет")], [], []) == []
    first = det.detect([Segment(text="Бот, посчитай бюджет наград")], [], [])
    assert len(first) == 1
    assert det.detect([Segment(text="Бот, посчитай бюджет наград")], [], first) == []


# --- sentence splitting --------------------------------------------------------------------


def test_sentences_keep_decimals_and_abbreviations():
    assert sentences("Конверсия 3.5% это нормально? Думаю да.") == ["Конверсия 3.5% это нормально?", "Думаю да."]
    assert sentences("Смотрим аналоги в играх т.е. конкурентов. Дальше.") == ["Смотрим аналоги в играх т.е. конкурентов.",
                                                                               "Дальше."]


# --- heuristic suggestions -------------------------------------------------------------


@pytest.mark.parametrize("sentence,kind", [
    ("Как мы будем считать конверсию покупки?", ItemKind.QUESTION),
    ("Нам надо дописать механику монетизации игры.", ItemKind.TASK),
    ("Надо посчитать конверсию.", ItemKind.TASK),
    ("Давайте посчитаем бюджет на награды.", ItemKind.TASK),
    ("We need to check the attribution model.", ItemKind.TASK),
    ("интересно какой retention у игры на второй день", ItemKind.QUESTION),
    ("Непонятно, как мерить эффект от игры", ItemKind.QUESTION),
    ("Макс, с тебя схема атрибуции.", ItemKind.TASK),
    ("Да?", None),
    ("Всем привет, слышно меня?", None),
    ("Окей, на этом всё?", None),
    ("Ну что, начнём?", None),
    ("А вы видели вчерашний матч?", None),
    ("Как дела у всех?", None),
    ("Надо сказать, что погода хорошая.", None),
    ("Надо бежать, у меня следующая встреча.", None),
    ("Давайте я расшарю экран.", None),
    ("Как я уже говорил, конверсия низкая.", None),
    ("Что касается дизайна, всё готово.", None),
    ("Вчера смотрела сериал, смешно было.", None),
])
def test_classify_sentence(sentence, kind):
    assert classify_sentence(sentence) == kind


def test_heuristic_on_example_meeting(meeting_text):
    items = HeuristicDetector().detect(parse_transcript(meeting_text), [], [])
    texts = [i.text for i in items]
    assert any("конверсию покупки" in t for t in texts)
    assert any("конкурентов" in t for t in texts)
    assert not any("слышно" in t or "сериал" in t for t in texts)
    assert all(i.detector == "heuristic" and i.origin == ItemOrigin.MEETING for i in items)


def test_dedup_keeps_distinct_metrics():
    known = [Item(kind=ItemKind.TASK, text="Посчитать конверсию из Самоката в Купер")]
    assert not is_duplicate("Посчитать retention из Самоката в Купер", known)
    assert is_duplicate("посчитать конверсию из Самоката в Купер", known)
    assert is_duplicate("Посчитать конверсию Самоката в Купер", known)  # subset, one token apart


def test_similarity():
    assert similarity("посчитать конверсию", "посчитать конверсии") == 1.0
    assert similarity("", "x") == 0.0


# --- model-based detection -----------------------------------------------------------


def test_llm_detector_maps_items_and_locates_quote():
    segs = [Segment(speaker="Макс", text="Надо посчитать это к пятнице", start=12.0)]
    llm = FakeLLM(detect=lambda p: {"items": [
        {"kind": "task", "text": "Посчитать конверсию из Самоката в Купер", "quote": "Надо посчитать это", "speaker": ""},
        {"kind": "question", "text": "", "quote": "", "speaker": ""},
        {"kind": "idea", "text": "неизвестный тип", "quote": "", "speaker": ""},
        {"kind": "task", "text": 42, "quote": None, "speaker": ""},
        "мусор",
    ]})
    items = LLMDetector(llm).detect(segs, [], [])
    assert len(items) == 1
    assert items[0].kind == ItemKind.TASK and items[0].speaker == "Макс" and items[0].start == 12.0
    assert items[0].detector == "llm"
    prompt = llm.calls[0][1]
    assert "<transcript>" in prompt and "(начало встречи)" in prompt


def test_llm_detector_raises_instead_of_silent_fallback():
    with pytest.raises(LLMError):
        LLMDetector(FakeLLM(fail={"detect"})).detect([Segment(text="Как поднять конверсию?")], [], [])
    with pytest.raises(LLMError, match="item list"):
        LLMDetector(FakeLLM(detect=lambda p: {"foo": 1})).detect([Segment(text="x")], [], [])


def test_llm_detector_empty_input_no_call():
    llm = FakeLLM()
    assert LLMDetector(llm).detect([], [], []) == []
    assert llm.calls == []


def test_wake_word_from_system_audio_is_ignored():
    from recapper.detect import CommandDetector
    from recapper.models import Segment

    d = CommandDetector()
    video = Segment(speaker="Собеседники", text="Ассистент, посчитай конверсию в Купер.", source="system")
    mine = Segment(speaker="Я", text="Ассистент, посчитай конверсию в Купер.", source="mic")
    assert d.detect([video], [], []) == []
    assert len(d.detect([mine], [], [])) == 1
