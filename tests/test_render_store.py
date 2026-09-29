from recapper.models import RecapSection, ActionItem, Answer, AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport, Recap, Segment, Source
from recapper.render import TELEGRAM_LIMIT, report_to_markdown, report_to_telegram, split_message
from recapper.store import ReportStore


def sample_report() -> MeetingReport:
    q = Item(kind=ItemKind.QUESTION, text="Как считать конверсию <в> Купер?", speaker="Макс", start=40.0,
             quote="как считать конверсию")
    t = Item(kind=ItemKind.TASK, text="Дописать механику", origin=ItemOrigin.USER)
    pending = Item(kind=ItemKind.TASK, text="Без ответа")
    return MeetingReport(
        title="Игра & Купер",
        segments=[Segment(speaker="Макс", text="как считать конверсию")],
        recap=Recap(summary="Итог <b>", decisions=["Промокод"], action_items=[ActionItem(text="Схема", owner="Макс", due="до пятницы")],
                    sections=[RecapSection(title="Гипотезы", bullets=["h1"]), RecapSection(title="Пусто", bullets=[])]),
        items=[q, t, pending],
        answers=[
            Answer(item_id=q.id, summary="Через промокод", body="Шаги & детали", assumptions=["5%"],
                   sources=[Source(title="Статья", ref="https://example.com/a?x=1&y=2"), Source(title="kb.md", ref="doc:kb.md")],
                   confidence="medium"),
            Answer(item_id=t.id, status=AnswerStatus.FAILED, body="err"),
        ],
        mode="claude",
    )


def test_markdown_contains_all_parts():
    md = report_to_markdown(sample_report())
    for part in ("# Игра & Купер", "## Решения", "Схема (Макс, до пятницы)", "## Мои задачи ассистенту (1)",
                 "### 1. Дописать механику", "Задача (от вас)", "не удалось подготовить ответ",
                 "## Прозвучало на встрече (2)", "### 2. Как считать конверсию", "*Вопрос, Макс, 00:40*",
                 "> как считать конверсию", "уверенность: средняя", "[Статья](<https://example.com/a?x=1&y=2>)",
                 "kb.md (doc:kb.md)", "_ответ не запрашивался_", "Режим: claude", "## Гипотезы", "- h1"):
        assert part in md, part


def test_markdown_empty_report_and_english():
    md = report_to_markdown(MeetingReport())
    assert "Ничего не найдено." in md and "## Пусто" not in md
    en = report_to_markdown(sample_report(), "en")
    assert "## My tasks for the assistant (1)" in en and "## Heard in the meeting (2)" in en and "Task (typed by you)" in en


def test_markdown_escapes_link_titles():
    r = sample_report()
    r.answers[0].sources = [Source(title="a]b[c", ref="https://x.example/p")]
    assert "[a\\]b\\[c](<https://x.example/p>)" in report_to_markdown(r)


def test_split_message_never_breaks_tags_or_entities():
    from recapper.render import _balanced, item_to_telegram

    long_item = Item(kind=ItemKind.TASK, text="Очень " * 1500 + "<b>&", origin=ItemOrigin.VOICE)
    parts = split_message(item_to_telegram(1, long_item, None))
    assert len(parts) > 1 and all(len(p) <= TELEGRAM_LIMIT for p in parts)
    assert all(_balanced(p) for p in parts)
    assert not any(p.endswith("&l") or p.endswith("&am") for p in parts)


def test_docx_export(tmp_path):
    from recapper.render import report_to_docx

    data = report_to_docx(sample_report())
    assert data[:2] == b"PK"
    import docx, io
    text = "\n".join(p.text for p in docx.Document(io.BytesIO(data)).paragraphs)
    assert "Мои задачи ассистенту" in text and "Статья (https://example.com/a?x=1&y=2)" in text


def test_telegram_escapes_html_and_links():
    msgs = report_to_telegram(sample_report())
    joined = "\n".join(msgs)
    assert "Игра &amp; Купер" in joined and "Итог &lt;b&gt;" in joined and "&lt;в&gt;" in joined
    assert '<a href="https://example.com/a?x=1&amp;y=2">Статья</a>' in joined
    assert "<b>" in joined  # our own markup survives


def test_split_message_respects_limit():
    long = "\n\n".join(["абзац " * 200] * 10) + "\n\n" + "x" * 9000
    parts = split_message(long)
    assert all(len(p) <= TELEGRAM_LIMIT for p in parts)
    assert "".join(parts).replace("\n", "").replace(" ", "") == long.replace("\n", "").replace(" ", "")
    assert split_message("коротко") == ["коротко"]


def test_long_answer_is_split_for_telegram():
    r = sample_report()
    r.answers[0].body = "строка\n" * 2000
    assert all(len(m) <= TELEGRAM_LIMIT for m in report_to_telegram(r))


def test_store_roundtrip_owner_scoping(tmp_path):
    store = ReportStore(tmp_path / "s.db")
    a, b = sample_report(), MeetingReport(title="Вторая")
    store.save(a, owner="1")
    store.save(b, owner="2")
    assert store.get(a.id).title == a.title
    assert store.get(a.id, owner="2") is None
    assert store.latest("1").id == a.id and store.latest("3") is None
    assert [r["id"] for r in store.list(owner="2")] == [b.id]
    assert len(store.list()) == 2
    assert not store.delete(a.id, owner="2") and store.delete(a.id, owner="1")
    assert store.get(a.id) is None
    store.close()


def test_store_latest_prefers_newest_and_upserts(tmp_path):
    store = ReportStore(tmp_path / "s.db")
    first, second = MeetingReport(title="1"), MeetingReport(title="2")
    store.save(first, owner="u")
    store.save(second, owner="u")
    assert store.latest("u").title == "2"
    second.title = "2b"
    store.save(second, owner="u")
    assert len(store.list(owner="u")) == 2 and store.get(second.id).title == "2b"


def test_store_can_drop_segments(tmp_path):
    store = ReportStore(tmp_path / "s.db", keep_segments=False)
    r = sample_report()
    store.save(r)
    assert store.get(r.id).segments == [] and r.segments  # original untouched
