"""Telegram bot tests: BotService logic and the handlers, driven with mocked Telegram
Update/Context/File objects (no network). AI calls are counted through the TracingLLM
that wraps the simulated provider."""

from __future__ import annotations

import asyncio
import html
import re
import subprocess
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from recapper.asr import ASRError
from recapper.bot import telegram_bot as tb
from recapper.bot.telegram_bot import (BotService, _reply, build_application, is_chatter, looks_like_transcript,
                                       make_handlers)
from recapper.config import Settings
from recapper.engine import Runtime
from recapper.i18n import t
from recapper.models import Answer, AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport, Segment, Source
from recapper.render import _TAG_RE, TELEGRAM_LIMIT, _balanced, report_to_telegram, split_message
from recapper.store import ReportStore

VOICE = "Ассистент, посчитай бюджет на награды для игры при среднем чеке 1900 рублей."
VOICE_TEXT = "Посчитай бюджет на награды для игры при среднем чеке 1900 рублей"
MEETING = (
    "Аня: Сегодня обсуждаем игру внутри приложения Самоката.\n"
    f"Аня: {VOICE}\n"
    "Макс: Как мы будем считать конверсию покупки из Самоката в Купер?\n"
    "Лена: Ладно, решили: награда в игре — это промокод на первый заказ в Купере."
)
QUESTION = "Как нам поднять конверсию промокодов в Купере?"


# --- test doubles & helpers -----------------------------------------------------------------------


class TextTranscriber:
    """Fake speech recognition: the downloaded "audio" is UTF-8 text, one segment per line."""

    def __init__(self) -> None:
        self.paths: list[Path] = []

    def transcribe(self, path: Path) -> list[Segment]:
        self.paths.append(Path(path))
        text = Path(path).read_bytes().decode("utf-8")
        if text.startswith("!asr-error"):
            raise ASRError("не удалось распознать аудио: битый файл")
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        return [Segment(text=ln, start=i * 5.0, end=i * 5.0 + 4.0) for i, ln in enumerate(lines)]


_DEFAULT = object()


def make_service(tmp_path: Path, provider: str = "sim-good", transcriber=_DEFAULT, allowed=frozenset({1}),
                 **settings) -> BotService:
    s = Settings(db_path=tmp_path / "bot.db", llm_provider=provider, telegram_allowed_users=set(allowed), **settings)
    runtime = Runtime(s, ReportStore(s.db_path))
    return BotService(runtime, TextTranscriber() if transcriber is _DEFAULT else transcriber)


@pytest.fixture
def service(tmp_path) -> BotService:
    return make_service(tmp_path)


@pytest.fixture
def handlers(service):
    return make_handlers(service)


def make_update(user_id: int = 1, text: str | None = None, document=None, voice=None, audio=None):
    message = MagicMock(name="message")
    message.text = text
    message.document = document
    message.voice = voice
    message.audio = audio
    message.reply_text = AsyncMock(name="reply_text")
    update = MagicMock(name="update")
    update.effective_user.id = user_id
    update.effective_message = message
    return update


def ctx(*args: str, error: BaseException | None = None):
    return MagicMock(name="context", args=list(args), error=error)


def make_document(name: str | None, data: bytes, size: int | None = None):
    doc = MagicMock(name="document")
    doc.file_name = name
    doc.file_size = len(data) if size is None else size
    tg_file = MagicMock(name="tg_file")
    tg_file.download_as_bytearray = AsyncMock(return_value=bytearray(data))
    doc.get_file = AsyncMock(return_value=tg_file)
    return doc


def make_voice(data: bytes, size: int | None = None):
    media = MagicMock(name="voice")
    media.file_size = len(data) if size is None else size
    tg_file = MagicMock(name="tg_file")

    async def download(custom_path=None, **_):
        Path(custom_path).write_bytes(data)

    tg_file.download_to_drive = AsyncMock(side_effect=download)
    media.get_file = AsyncMock(return_value=tg_file)
    return media


def calls(update):
    return update.effective_message.reply_text.await_args_list


def replies(update) -> list[str]:
    return [c.args[0] for c in calls(update)]


def run(coro):
    return asyncio.run(coro)


def ai_calls(service: BotService, method: str | None = None) -> int:
    return sum(1 for r in service.runtime.llm.records if method is None or r.method == method)


def stored(service: BotService, user_id: int = 1) -> list[MeetingReport]:
    return service.runtime.store.all(f"tg:{user_id}")


def plain(messages: list[str]) -> str:
    return html.unescape("\n".join(re.sub(r"<[^>]+>", "", m) for m in messages))


def assert_telegram_safe(messages: list[str]) -> None:
    for m in messages:
        assert 0 < len(m) <= TELEGRAM_LIMIT
        assert _balanced(m) or not _TAG_RE.search(m), m[:200]
        assert not re.search(r"&[a-z#0-9]*$", m), "entity cut at the end of a message"
        assert not re.match(r"^(amp|lt|gt|quot);", m), "entity cut at the start of a message"


# --- access control ---------------------------------------------------------------------------------


def test_allowed_fails_closed_with_empty_allowlist(tmp_path):
    service = make_service(tmp_path, allowed=set())
    assert not any(service.allowed(uid) for uid in (0, 1, 2, 123456789, -1))


def test_allowed_allowlist(tmp_path):
    service = make_service(tmp_path, allowed={1, 42})
    assert service.allowed(1) and service.allowed(42)
    assert not service.allowed(2) and not service.allowed(0)


@pytest.mark.parametrize("allowed", [set(), {1}])
def test_allowed_public_bot_lets_everyone_in(tmp_path, allowed):
    service = make_service(tmp_path, allowed=allowed, telegram_public=True)
    assert all(service.allowed(uid) for uid in (1, 2, 999))


def test_allowed_follows_live_settings(service):
    new = Settings(db_path=service.settings.db_path, llm_provider="sim-good", telegram_allowed_users={2})
    service.runtime.apply_settings(new)
    assert service.allowed(2) and not service.allowed(1)


# --- build_application --------------------------------------------------------------------------------


class _Filter:
    def __init__(self, name: str) -> None:
        self.name = name

    def __or__(self, other):
        return _Filter(f"({self.name} | {other.name})")

    def __and__(self, other):
        return _Filter(f"({self.name} & {other.name})")

    def __invert__(self):
        return _Filter(f"~{self.name}")


@pytest.fixture
def fake_ptb(monkeypatch):
    """A minimal stand-in for ``telegram.ext`` (the real package is not importable in every
    environment, and build_application must not touch the network anyway)."""
    built: list = []

    class FakeApp:
        def __init__(self, opts):
            self.opts, self.handlers, self.error_handlers = opts, [], []

        def add_handler(self, handler):
            self.handlers.append(handler)

        def add_error_handler(self, callback):
            self.error_handlers.append(callback)

    class Builder:
        def __init__(self):
            self.opts = {}

        def token(self, value):
            self.opts["token"] = value
            return self

        def concurrent_updates(self, value):
            self.opts["concurrent_updates"] = value
            return self

        def build(self):
            app = FakeApp(self.opts)
            built.append(app)
            return app

    class Application:
        @staticmethod
        def builder():
            return Builder()

    class CommandHandler:
        def __init__(self, command, callback):
            self.commands = [command] if isinstance(command, str) else list(command)
            self.callback = callback

    class MessageHandler:
        def __init__(self, filters, callback):
            self.filters, self.callback = filters, callback

    ext = types.ModuleType("telegram.ext")
    ext.Application, ext.CommandHandler, ext.MessageHandler = Application, CommandHandler, MessageHandler
    ext.filters = types.SimpleNamespace(Document=types.SimpleNamespace(ALL=_Filter("Document.ALL")),
                                        VOICE=_Filter("VOICE"), AUDIO=_Filter("AUDIO"), TEXT=_Filter("TEXT"),
                                        COMMAND=_Filter("COMMAND"))
    pkg = types.ModuleType("telegram")
    pkg.__path__ = []
    pkg.ext = ext
    monkeypatch.setitem(sys.modules, "telegram", pkg)
    monkeypatch.setitem(sys.modules, "telegram.ext", ext)
    return built


def test_build_application_requires_token(service, fake_ptb):
    with pytest.raises(SystemExit) as exc:
        build_application(Settings(telegram_token="", telegram_allowed_users={1}), service)
    assert "TELEGRAM_BOT_TOKEN" in str(exc.value)
    assert fake_ptb == []


def test_build_application_requires_allowlist_unless_public(service, fake_ptb):
    with pytest.raises(SystemExit) as exc:
        build_application(Settings(telegram_token="123:ABC", telegram_allowed_users=set()), service)
    assert "RECAPPER_TELEGRAM_ALLOWED_USERS" in str(exc.value) and "RECAPPER_TELEGRAM_PUBLIC" in str(exc.value)
    assert fake_ptb == []


@pytest.mark.parametrize("settings", [
    Settings(telegram_token="123:ABC", telegram_allowed_users={1}),
    Settings(telegram_token="123:ABC", telegram_public=True),
], ids=["allowlist", "public"])
def test_build_application_wires_handlers(service, fake_ptb, settings):
    app = build_application(settings, service)
    assert fake_ptb == [app]
    assert app.opts == {"token": "123:ABC", "concurrent_updates": True}
    commands = {tuple(h.commands): h.callback.__name__ for h in app.handlers if hasattr(h, "commands")}
    assert commands == {("start", "help"): "start", ("ask",): "ask", ("last",): "last", ("history",): "history",
                        ("delete",): "delete"}
    messages = [(h.filters.name, h.callback.__name__) for h in app.handlers if hasattr(h, "filters")]
    assert messages == [("Document.ALL", "document"), ("(VOICE | AUDIO)", "audio"), ("(TEXT & ~COMMAND)", "text")]
    assert [cb.__name__ for cb in app.error_handlers] == ["on_error"]


def _ptb_importable() -> bool:
    probe = subprocess.run([sys.executable, "-c", "import telegram.ext"], capture_output=True, timeout=60)
    return probe.returncode == 0


def test_build_application_with_real_python_telegram_bot(service):
    if not _ptb_importable():
        pytest.skip("python-telegram-bot cannot be imported in this environment (broken cryptography/cffi)")
    app = build_application(Settings(telegram_token="123:ABC", telegram_allowed_users={1}), service)
    assert len(app.handlers[0]) == 8 and len(app.error_handlers) == 1


# --- /start, access denial ------------------------------------------------------------------------------


@pytest.mark.parametrize("command", ["start", "help"])
def test_start_replies_with_help(handlers, command):
    update = make_update()
    run(handlers[command](update, ctx()))
    assert replies(update) == [t("bot_help", "ru")]
    assert "Ассистент" in replies(update)[0]


def test_start_in_english(tmp_path):
    handlers = make_handlers(make_service(tmp_path, ui_language="en"))
    update = make_update()
    run(handlers["start"](update, ctx()))
    assert replies(update) == [t("bot_help", "en")]


def _denied_cases():
    doc = make_document("meeting.txt", MEETING.encode())
    voice = make_voice(VOICE.encode())
    return [
        ("start", make_update(99), ctx()),
        ("help", make_update(99), ctx()),
        ("ask", make_update(99), ctx("Как", "считать", "конверсию?")),
        ("last", make_update(99), ctx()),
        ("history", make_update(99), ctx()),
        ("delete", make_update(99), ctx()),
        ("text", make_update(99, text=MEETING), ctx()),
        ("text", make_update(99, text=QUESTION), ctx()),
        ("document", make_update(99, document=doc), ctx()),
        ("audio", make_update(99, voice=voice), ctx()),
    ]


@pytest.mark.parametrize("index", range(len(_denied_cases())))
def test_denied_user_gets_denial_and_nothing_is_processed(service, handlers, monkeypatch, index):
    name, update, context = _denied_cases()[index]
    spies = {}
    for method in ("process_text", "process_audio", "ask", "last", "history", "delete_all"):
        spies[method] = AsyncMock(name=method)
        monkeypatch.setattr(service, method, spies[method])
    run(handlers[name](update, context))
    assert replies(update) == [t("bot_denied", "ru")]
    assert all(not spy.await_count for spy in spies.values())
    msg = update.effective_message
    if name == "document":
        msg.document.get_file.assert_not_awaited()
    if name == "audio":
        msg.voice.get_file.assert_not_awaited()
    assert ai_calls(service) == 0 and stored(service, 99) == []


# --- text messages ----------------------------------------------------------------------------------------


def test_text_transcript_is_processed_as_meeting(service, handlers):
    update = make_update(text=MEETING)
    run(handlers["text"](update, ctx()))
    all_calls = calls(update)
    assert all_calls[0].args == (t("bot_processing", "ru"),) and "parse_mode" not in all_calls[0].kwargs
    messages = replies(update)[1:]
    assert len(messages) >= 2
    for c in all_calls[1:]:
        assert c.kwargs == {"parse_mode": "HTML", "disable_web_page_preview": True}
    assert_telegram_safe(messages)
    command_msg = next(m for m in messages if VOICE_TEXT in m)
    assert command_msg.startswith(f"<b>1. {VOICE_TEXT}</b>")
    assert "Задача (голосом), Аня" in command_msg and f"Черновик по теме «{VOICE_TEXT}»" in command_msg
    assert messages[0].startswith("<b>Встреча</b>") and "Мои задачи ассистенту: 1" in messages[0]
    reports = stored(service)
    assert len(reports) == 1 and len(reports[0].segments) == 4
    voice = [i for i in reports[0].items if i.origin == ItemOrigin.VOICE]
    assert len(voice) == 1 and reports[0].answer_for(voice[0].id).status == AnswerStatus.DRAFT
    assert ai_calls(service, "research") == 1


@pytest.mark.parametrize("text", ["ок", "спасибо", "Спасибо!", "👍", "ок, понял", "", "   "])
def test_short_chatter_gets_hint_without_ai_call(service, handlers, monkeypatch, text):
    ask = AsyncMock(name="ask")
    monkeypatch.setattr(service, "ask", ask)
    update = make_update(text=text)
    run(handlers["text"](update, ctx()))
    assert replies(update) == [t("bot_short", "ru")]
    ask.assert_not_awaited()
    assert ai_calls(service) == 0 and stored(service) == []


def test_text_none_is_treated_as_chatter(service, handlers):
    update = make_update(text=None)
    run(handlers["text"](update, ctx()))
    assert replies(update) == [t("bot_short", "ru")] and ai_calls(service) == 0


@pytest.mark.parametrize("text", [QUESTION, "Сколько стоит?", "Аня: как считать конверсию в Купер?"])
def test_real_question_is_answered(service, handlers, text):
    update = make_update(text=text)
    run(handlers["text"](update, ctx()))
    messages = replies(update)
    assert t("bot_processing", "ru") not in messages and t("bot_short", "ru") not in messages
    assert len(messages) == 1 and calls(update)[0].kwargs["parse_mode"] == "HTML"
    assert "Вопрос (от вас)" in messages[0] and "<b>Коротко:</b>" in messages[0]
    assert html.escape(text.strip(), quote=False) in messages[0]
    assert ai_calls(service, "research") == 1
    (report,) = stored(service)
    assert report.title == "Вопросы без встречи"
    assert [i.origin for i in report.items] == [ItemOrigin.USER]
    assert report.answers[0].status == AnswerStatus.DRAFT


def test_question_is_attached_to_latest_meeting(service, handlers):
    run(handlers["text"](make_update(text=MEETING), ctx()))
    update = make_update(text=QUESTION)
    run(handlers["text"](update, ctx()))
    (report,) = stored(service)
    assert report.items[-1].text == QUESTION and report.items[-1].origin == ItemOrigin.USER
    assert report.answer_for(report.items[-1].id).status == AnswerStatus.DRAFT
    assert replies(update)[0].startswith(f"<b>{len(report.items)}. {QUESTION}</b>")


def test_ask_command(service, handlers):
    update = make_update()
    run(handlers["ask"](update, ctx("Как", "считать", "конверсию?")))
    assert "<b>1. Как считать конверсию?</b>" in replies(update)[0]
    assert ai_calls(service, "research") == 1
    empty = make_update()
    run(handlers["ask"](empty, ctx()))
    assert replies(empty) == [t("bot_ask_empty", "ru")]
    blank = make_update()
    run(handlers["ask"](blank, MagicMock(args=None)))
    assert replies(blank) == [t("bot_ask_empty", "ru")]
    assert ai_calls(service, "research") == 1


def test_failed_answer_is_reported(tmp_path):
    service = make_service(tmp_path, provider="sim-broken")
    handlers = make_handlers(service)
    texts = []
    for _ in range(3):  # the broken simulator fails 2 of every 3 answers
        update = make_update(text=QUESTION)
        run(handlers["text"](update, ctx()))
        texts.append(replies(update)[0])
    failed = [m for m in texts if t("bot_failed", "ru") in m]
    assert failed and all("не удалось подготовить ответ" in m for m in failed)


# --- documents --------------------------------------------------------------------------------------------


VTT = ("WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n<v Аня>Сегодня обсуждаем игру.</v>\n\n"
       f"00:00:06.000 --> 00:00:09.000\n<v Аня>{VOICE}</v>\n")
SRT = f"1\n00:00:01,000 --> 00:00:05,000\nАня: Сегодня обсуждаем игру.\n\n2\n00:00:06,000 --> 00:00:09,000\nАня: {VOICE}\n"


@pytest.mark.parametrize("name,content", [
    ("Планёрка.txt", MEETING), ("call.vtt", VTT), ("call.srt", SRT), ("notes.md", MEETING), ("UPPER.TXT", MEETING),
])
def test_document_transcript_is_processed(service, handlers, name, content):
    doc = make_document(name, content.encode())
    update = make_update(document=doc)
    run(handlers["document"](update, ctx()))
    doc.get_file.assert_awaited_once()
    messages = replies(update)
    assert messages[0] == t("bot_processing", "ru")
    assert any(m.startswith(f"<b>1. {VOICE_TEXT}</b>") for m in messages[1:])
    assert_telegram_safe(messages[1:])
    (report,) = stored(service)
    assert report.title == Path(name).stem
    assert any(i.origin == ItemOrigin.VOICE for i in report.items)


@pytest.mark.parametrize("name", ["report.pdf", "meeting.docx", "noext", None, "audio.ogg"])
def test_document_unsupported_extension(service, handlers, name):
    doc = make_document(name, MEETING.encode())
    update = make_update(document=doc)
    run(handlers["document"](update, ctx()))
    assert replies(update) == [t("bot_files", "ru")]
    doc.get_file.assert_not_awaited()
    assert stored(service) == []


def test_document_too_big(service, handlers):
    doc = make_document("huge.txt", b"x", size=tb.MAX_FILE_BYTES + 1)
    update = make_update(document=doc)
    run(handlers["document"](update, ctx()))
    assert replies(update) == [t("bot_too_big", "ru")]
    doc.get_file.assert_not_awaited()


def test_document_without_utterances(service, handlers):
    update = make_update(document=make_document("empty.txt", b"\n \n"))
    run(handlers["document"](update, ctx()))
    assert replies(update) == [t("bot_processing", "ru"), t("bot_no_segments", "ru")]
    assert stored(service) == [] and ai_calls(service) == 0


def test_document_with_invalid_utf8_is_still_processed(service, handlers):
    data = MEETING.encode() + b"\n\xff\xfe broken bytes"
    update = make_update(document=make_document("m.txt", data))
    run(handlers["document"](update, ctx()))
    assert any(VOICE_TEXT in m for m in replies(update))


# --- voice notes and audio ----------------------------------------------------------------------------------


def test_voice_with_wake_word_is_processed_as_meeting(service, handlers):
    voice = make_voice("Ассистент, придумай название для игры про корзину.".encode())
    update = make_update(voice=voice)
    run(handlers["audio"](update, ctx()))
    messages = replies(update)
    assert messages[0] == t("bot_recognizing", "ru") and "parse_mode" not in calls(update)[0].kwargs
    assert any(m.startswith("<b>1. Придумай название для игры про корзину</b>") for m in messages)
    assert any("Задача (голосом), Я" in m for m in messages)
    path = voice.get_file.return_value.download_to_drive.await_args.kwargs["custom_path"]
    assert Path(path).suffix == ".ogg" and not Path(path).exists()  # audio is deleted after recognition
    (report,) = stored(service)
    assert report.title == "Голосовая заметка" and report.segments[0].speaker == "Я"
    (item,) = [i for i in report.items if i.origin == ItemOrigin.VOICE]
    assert report.answer_for(item.id).status == AnswerStatus.DRAFT


def test_voice_without_wake_word_is_a_question(service, handlers):
    update = make_update(voice=make_voice(f"{QUESTION}\nИ что с бюджетом?".encode()))
    run(handlers["audio"](update, ctx()))
    messages = replies(update)
    assert messages[0] == t("bot_recognizing", "ru")
    assert "Вопрос (от вас)" in messages[1] and f"{QUESTION} И что с бюджетом?" in messages[1]
    (report,) = stored(service)
    assert [i.origin for i in report.items] == [ItemOrigin.USER]
    assert ai_calls(service, "research") == 1


def test_audio_file_message_is_handled_like_voice(service, handlers):
    update = make_update(voice=None, audio=make_voice(VOICE.encode()))
    run(handlers["audio"](update, ctx()))
    assert any(m.startswith(f"<b>1. {VOICE_TEXT}</b>") for m in replies(update))


def test_voice_too_big(service, handlers):
    voice = make_voice(b"x", size=tb.MAX_FILE_BYTES + 1)
    update = make_update(voice=voice)
    run(handlers["audio"](update, ctx()))
    assert replies(update) == [t("bot_too_big", "ru")]
    voice.get_file.assert_not_awaited()


def test_voice_without_asr(tmp_path):
    service = make_service(tmp_path, transcriber=None)  # asr_provider "none"
    update = make_update(voice=make_voice(VOICE.encode()))
    run(make_handlers(service)["audio"](update, ctx()))
    assert replies(update) == [t("bot_recognizing", "ru"), t("bot_no_asr", "ru")]
    assert ai_calls(service) == 0


@pytest.mark.parametrize("payload,expected", [
    (b"!asr-error", "не удалось распознать аудио: битый файл"),
    (b"  \n ", t("bot_no_speech", "ru")),
])
def test_voice_recognition_problems(service, handlers, payload, expected):
    update = make_update(voice=make_voice(payload))
    run(handlers["audio"](update, ctx()))
    assert replies(update) == [t("bot_recognizing", "ru"), expected]
    assert ai_calls(service) == 0 and stored(service) == []


def test_voice_chatter_does_not_trigger_ai(service, handlers):
    update = make_update(voice=make_voice("Спасибо.".encode()))
    run(handlers["audio"](update, ctx()))
    assert ai_calls(service) == 0
    assert replies(update)[-1] == t("bot_short", "ru")


# --- /last, /history, /delete ---------------------------------------------------------------------------------


def test_last_history_delete(service, handlers):
    def command(name):
        update = make_update()
        run(handlers[name](update, ctx()))
        return replies(update)

    assert command("last") == [t("bot_no_reports", "ru")]
    assert command("history") == [t("bot_history_empty", "ru")]
    run(handlers["text"](make_update(text=MEETING), ctx()))
    run(handlers["document"](make_update(document=make_document("Ретро.txt", MEETING.encode())), ctx()))

    last = command("last")
    assert last[0].startswith("<b>Ретро</b>") and any(VOICE_TEXT in m for m in last)
    assert_telegram_safe(last)
    history = command("history")
    assert len(history) == 1
    lines = history[0].splitlines()
    assert len(lines) == 2 and lines[0].endswith("— Ретро") and lines[1].endswith("— Встреча")
    assert all(re.match(r"^• \d{4}-\d{2}-\d{2} — ", line) for line in lines)

    assert command("delete") == [t("bot_deleted", "ru", n=2)]
    assert command("last") == [t("bot_no_reports", "ru")]
    assert command("history") == [t("bot_history_empty", "ru")]
    assert command("delete") == [t("bot_deleted", "ru", n=0)]
    assert stored(service) == []


def test_owner_isolation_between_users(tmp_path):
    service = make_service(tmp_path, provider="none", allowed={1, 2})
    handlers = make_handlers(service)
    secret = "Аня: Обсуждаем секретный зефирный проект.\nМакс: Решили запускать зефирный проект в марте."
    run(handlers["document"](make_update(1, document=make_document("Зефир.txt", secret.encode())), ctx()))
    run(handlers["document"](make_update(1, document=make_document("Дизайн.txt", MEETING.encode())), ctx()))

    def command(user_id, name, *args):
        update = make_update(user_id)
        run(handlers[name](update, ctx(*args)))
        return replies(update)

    assert command(2, "last") == [t("bot_no_reports", "ru")]
    assert command(2, "history") == [t("bot_history_empty", "ru")]
    assert run(service.memory_hint(2, "зефирный проект")) == ""
    assert "зефирный" in run(service.memory_hint(1, "зефирный проект"))

    mine = plain(command(1, "ask", "Что", "решили", "про", "зефирный", "проект?"))
    assert "Из прошлых встреч" in mine and "Встреча «Зефир»" in mine
    theirs = plain(command(2, "ask", "Что", "решили", "про", "зефирный", "проект?"))
    assert "Зефир" not in theirs and "Ничего подходящего" in theirs

    assert command(2, "delete") == [t("bot_deleted", "ru", n=1)]  # only their own question log
    assert {r.title for r in stored(service, 1)} == {"Зефир", "Дизайн"}
    assert command(1, "last")[0].startswith("<b>Дизайн</b>")


# --- Telegram formatting ------------------------------------------------------------------------------------


def test_reply_falls_back_to_plain_text_when_html_is_rejected():
    update = make_update()
    send = AsyncMock(side_effect=[Exception("Bad Request: can't parse entities"), None, None])
    update.effective_message.reply_text = send
    run(_reply(update, ["<b>Итог</b>\n<i>курсив</i> и <a href=\"https://example.com\">ссылка</a>", "<b>второе</b>"]))
    assert len(send.await_args_list) == 3
    first, fallback, second = send.await_args_list
    assert first.kwargs["parse_mode"] == "HTML"
    assert fallback.args == ("Итог\nкурсив и ссылка",) and "parse_mode" not in fallback.kwargs
    assert fallback.kwargs["disable_web_page_preview"] is True
    assert second.args == ("<b>второе</b>",) and second.kwargs["parse_mode"] == "HTML"


def test_reply_plain_fallback_unescapes_entities():
    update = make_update()
    send = AsyncMock(side_effect=[Exception("Bad Request: can't parse entities"), None])
    update.effective_message.reply_text = send
    run(_reply(update, ["<b>Q&amp;A</b>: 5 &lt; 6 &gt; 4"]))
    assert send.await_args_list[1].args == ("Q&A: 5 < 6 > 4",)


def _long_report() -> MeetingReport:
    item = Item(kind=ItemKind.TASK, text="Посчитай бюджет " + "очень длинная задача & <тег> " * 300,
                origin=ItemOrigin.VOICE, speaker="Аня", start=65)
    body = "\n\n".join(
        [f"Абзац {i}: " + ("слово & <b>не тег</b> " * 40) for i in range(30)]
        + ["ОДНАСТРОКА" + ("x&y<z>" * 3000)]
        + ["\n".join(f"- пункт {j} " + "текст " * 30 for j in range(200))]
    )
    answer = Answer(item_id=item.id, summary="Итог " * 1500, body=body, assumptions=["допущение " * 50] * 40,
                    warnings=["предупреждение " * 30] * 20, confidence="high",
                    sources=[Source(title=f"Источник {i} " * 10, ref=f"https://example.com/{i}?q=" + "a" * 200)
                             for i in range(40)])
    heard = Item(kind=ItemKind.QUESTION, text="Как считать конверсию?", speaker="Макс")
    report = MeetingReport(title="Встреча <&> " * 500, items=[heard, item], answers=[answer])
    report.recap.summary = "Резюме " * 2000
    report.recap.decisions = ["решение " * 100] * 20
    return report


def test_report_to_telegram_long_answer_is_split_safely():
    report = _long_report()
    messages = report_to_telegram(report)
    assert len(messages) > 10
    assert_telegram_safe(messages)
    text = plain(messages)
    positions = [text.find(f"Абзац {i}:") for i in range(30)]
    assert all(p >= 0 for p in positions) and positions == sorted(positions)  # nothing lost, order kept
    assert "пункт 199" in text
    # The 48 KB single line is hard-cut across messages without losing a character or an entity.
    glued = html.unescape("".join(re.sub(r"<[^>]+>", "", m) for m in messages))
    assert glued.count("x&y<z>") == 3000
    # The user's own task comes before what was heard in the meeting.
    assert text.find("Посчитай бюджет") < text.find("Как считать конверсию?")


@pytest.mark.parametrize("limit", [200, 1000, TELEGRAM_LIMIT])
def test_split_message_respects_limit_and_markup(limit):
    block = "\n\n".join(
        f"<b>Раздел {i}</b>\n<i>{'подпись ' * (i % 7 + 1)}</i>\n" + "&lt;данные&gt; & текст " * (i * 3)
        for i in range(60))
    parts = split_message(block, limit)
    assert all(len(p) <= limit for p in parts)
    assert all(_balanced(p) or not _TAG_RE.search(p) for p in parts)
    assert plain(parts).count("Раздел") == 60


def test_split_message_short_text_is_untouched():
    assert split_message("<b>коротко</b>") == ["<b>коротко</b>"]
    exact = "а" * TELEGRAM_LIMIT
    assert split_message(exact) == [exact]


# --- error handler, helpers ------------------------------------------------------------------------------------


def test_error_handler_replies_with_failure_text(handlers):
    update = make_update()
    run(handlers["error"](update, ctx(error=RuntimeError("boom"))))
    assert replies(update) == [t("bot_failed", "ru")]


def test_error_handler_without_message(handlers):
    run(handlers["error"](None, ctx(error=RuntimeError("boom"))))  # e.g. a failed poll: nothing to reply to
    update = MagicMock(effective_message=None)
    run(handlers["error"](update, ctx(error=RuntimeError("boom"))))


def test_error_handler_in_english(tmp_path):
    handlers = make_handlers(make_service(tmp_path, ui_language="en"))
    update = make_update()
    run(handlers["error"](update, ctx(error=RuntimeError("boom"))))
    assert replies(update) == ["Something went wrong. Please try again."]


@pytest.mark.parametrize("text,expected", [
    ("ок", True), ("спасибо", True), ("👍", True), ("", True), ("да да", True),
    ("Сколько?", False), ("как считать конверсию", False), (QUESTION, False),
])
def test_is_chatter(text, expected):
    assert is_chatter(text) is expected


@pytest.mark.parametrize("text,expected", [
    (MEETING, True),
    ("Аня: привет\nМакс: привет", True),
    ("Аня: " + "длинная реплика " * 20, True),
    ("Аня: короткая реплика", False),
    (QUESTION, False),
    ("Привет!\nКак нам поднять конверсию?", False),
])
def test_looks_like_transcript(text, expected):
    assert looks_like_transcript(text) is expected
