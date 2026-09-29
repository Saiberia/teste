import pytest

from recapper.detect import HeuristicDetector, LLMDetector, classify_sentence, is_duplicate, similarity
from recapper.models import Item, ItemKind, Segment
from recapper.transcript import parse_transcript
from tests.fakes import FakeLLM


@pytest.mark.parametrize("sentence,kind", [
    ("Как мы будем считать конверсию покупки?", ItemKind.QUESTION),
    ("Какие механики работают у конкурентов", ItemKind.QUESTION),
    ("Нам надо дописать механику монетизации игры.", ItemKind.TASK),
    ("Давайте посчитаем бюджет на награды.", ItemKind.TASK),
    ("We need to check the attribution model.", ItemKind.TASK),
    ("Да?", None),
    ("Всем привет, слышно меня?", None),
    ("Окей, на этом всё?", None),
    ("Надо сказать, что погода хорошая.", None),
    ("Вчера смотрела сериал, смешно было.", None),
])
def test_classify_sentence(sentence, kind):
    assert classify_sentence(sentence) == kind


def test_heuristic_on_example_meeting(meeting_text):
    items = HeuristicDetector().detect(parse_transcript(meeting_text), [], [])
    texts = [i.text for i in items]
    assert any("монетизации" in t for t in texts)
    assert any("конверсию покупки" in t for t in texts)
    assert any("конкурентов" in t for t in texts)
    assert not any("слышно" in t for t in texts)
    assert not any("сериал" in t for t in texts)
    conv = next(i for i in items if "конверсию" in i.text)
    assert conv.speaker == "Макс" and conv.start == 40.0 and conv.kind == ItemKind.QUESTION


def test_heuristic_skips_known_duplicates():
    known = [Item(kind=ItemKind.TASK, text="надо дописать механику монетизации игры")]
    items = HeuristicDetector().detect([Segment(text="Надо дописать механику монетизации игры.")], [], known)
    assert items == []


def test_similarity_and_duplicate():
    assert similarity("посчитать конверсию", "посчитать конверсии") == 1.0
    assert similarity("", "x") == 0.0
    assert is_duplicate("посчитать конверсию в Купер", [Item(kind=ItemKind.TASK, text="посчитать конверсию Купер")])


def test_llm_detector_maps_items_and_locates_quote():
    segs = [Segment(speaker="Макс", text="Надо посчитать это к пятнице", start=12.0)]
    llm = FakeLLM(detect=lambda p: {"items": [
        {"kind": "task", "text": "Посчитать конверсию из Самоката в Купер", "quote": "Надо посчитать это", "speaker": ""},
        {"kind": "question", "text": "", "quote": "", "speaker": ""},  # empty text is dropped
    ]})
    items = LLMDetector(llm).detect(segs, [], [])
    assert len(items) == 1
    assert items[0].kind == ItemKind.TASK and items[0].speaker == "Макс" and items[0].start == 12.0
    prompt = llm.calls[0][1]
    assert "СВЕЖИЙ фрагмент" in prompt and "(начало встречи)" in prompt


def test_llm_detector_passes_known_and_dedups():
    known = [Item(kind=ItemKind.TASK, text="Посчитать конверсию из Самоката в Купер")]
    llm = FakeLLM(detect=lambda p: {"items": [
        {"kind": "task", "text": "Посчитать конверсию из Самоката в Купер", "quote": "", "speaker": "А"}]})
    assert LLMDetector(llm).detect([Segment(text="что-то")], [], known) == []
    assert "Посчитать конверсию" in llm.calls[0][1]


def test_llm_detector_falls_back_on_error():
    llm = FakeLLM(fail={"detect"})
    items = LLMDetector(llm).detect([Segment(text="Как нам поднять конверсию в Купер?")], [], [])
    assert [i.kind for i in items] == [ItemKind.QUESTION]


def test_llm_detector_empty_input_no_call():
    llm = FakeLLM()
    assert LLMDetector(llm).detect([], [], []) == []
    assert llm.calls == []
