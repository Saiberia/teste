"""Telegram bot: delivery channel and quick questions.

The bot cannot listen to a Zoom/Телемост call by itself: it receives
transcripts, files and voice notes, and answers questions using all of the
user's meetings (memory). Logic lives in ``BotService`` (easy to test); the
handlers only translate Telegram updates. Every blocking call runs in a thread.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import tempfile
import threading
from pathlib import Path

from ..answer import memory_context
from ..asr import ASRError, Transcriber, get_transcriber
from ..config import Settings
from ..engine import Runtime, process_segments
from ..i18n import t
from ..models import AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport
from ..render import item_to_telegram, report_to_telegram, split_message
from ..store import ReportStore
from ..transcript import parse_transcript

log = logging.getLogger(__name__)

TRANSCRIPT_SUFFIXES = {".txt", ".vtt", ".srt", ".md"}
MAX_FILE_BYTES = 20 * 1024 * 1024  # Bot API download limit
MIN_QUESTION_WORDS = 3


def owner_of(user_id: int) -> str:
    return f"tg:{user_id}"


class BotService:
    def __init__(self, runtime: Runtime, transcriber: Transcriber | None = None):
        self.runtime = runtime
        self._transcriber = transcriber
        self._asr_lock = threading.Lock()

    @property
    def settings(self) -> Settings:
        return self.runtime.settings

    @property
    def lang(self) -> str:
        return self.settings.ui_language

    def allowed(self, user_id: int) -> bool:
        s = self.settings
        if s.telegram_public:
            return True
        return user_id in s.telegram_allowed_users  # fail closed: empty list = nobody

    def _get_transcriber(self) -> Transcriber | None:
        with self._asr_lock:
            if self._transcriber is None:
                self._transcriber = get_transcriber(self.settings)
            return self._transcriber

    def _process(self, user_id: int, segments, title: str) -> list[str]:
        owner = owner_of(user_id)
        components = self.runtime.components(title, owner)
        report = process_segments(segments, components, title=title, auto_answer=self.settings.auto_answer,
                                  template=self.settings.default_template)
        self.runtime.store.save(report, owner=owner)
        return report_to_telegram(report, self.lang)

    async def process_text(self, user_id: int, text: str, title: str = "Встреча") -> list[str]:
        segments = parse_transcript(text)
        if not segments:
            return [t("bot_no_segments", self.lang)]
        return await asyncio.to_thread(self._process, user_id, segments, title)

    async def process_audio(self, user_id: int, path: Path, title: str = "Голосовая заметка") -> list[str]:
        try:
            transcriber = await asyncio.to_thread(self._get_transcriber)
        except ASRError as exc:
            return [str(exc)]
        if transcriber is None:
            return [t("bot_no_asr", self.lang)]
        try:
            segments = await asyncio.to_thread(transcriber.transcribe, path)
        except ASRError as exc:
            return [str(exc)]
        if not segments:
            return [t("bot_no_speech", self.lang)]
        # A voice note sent to the bot is a request to the assistant as a whole.
        me = self.settings.me_label
        for seg in segments:
            seg.speaker = seg.speaker or me
        commands = self.runtime.components(title, owner_of(user_id)).commands.detect(segments, [], [])
        if not commands:
            text = " ".join(s.text for s in segments)
            if is_chatter(text):  # "Спасибо." must not trigger a paid answer
                return [t("bot_short", self.lang)]
            return await self.ask(user_id, text)
        return await asyncio.to_thread(self._process, user_id, segments, title)

    def _ask(self, user_id: int, question: str) -> list[str]:
        owner = owner_of(user_id)
        latest = self.runtime.store.latest(owner)
        report = latest or MeetingReport(title="Вопросы без встречи")
        components = self.runtime.components(report.title, owner, exclude_id=report.id if latest else None)
        item = Item(kind=ItemKind.QUESTION, text=question, origin=ItemOrigin.USER, detector="user")
        answer = components.answerer.answer(item, report.segments)
        report.mode = components.mode
        report.items.append(item)
        report.answers.append(answer)
        self.runtime.store.save(report, owner=owner)
        text = item_to_telegram(len(report.items), item, answer, self.lang)
        if answer.status == AnswerStatus.FAILED:
            text += "\n\n" + t("bot_failed", self.lang)
        return split_message(text)

    async def ask(self, user_id: int, question: str) -> list[str]:
        question = question.strip()
        if len(question) < 2:
            return [t("bot_ask_empty", self.lang)]
        return await asyncio.to_thread(self._ask, user_id, question)

    async def last(self, user_id: int) -> list[str]:
        report = await asyncio.to_thread(self.runtime.store.latest, owner_of(user_id))
        return report_to_telegram(report, self.lang) if report else [t("bot_no_reports", self.lang)]

    async def history(self, user_id: int) -> list[str]:
        rows = await asyncio.to_thread(self.runtime.store.list, owner_of(user_id), 20)
        if not rows:
            return [t("bot_history_empty", self.lang)]
        return split_message("\n".join(f"• {r['created_at'][:10]} — {r['title']}" for r in rows))

    async def delete_all(self, user_id: int) -> list[str]:
        owner = owner_of(user_id)

        def run() -> int:
            rows = self.runtime.store.list(owner, 10_000)
            return sum(1 for r in rows if self.runtime.store.delete(r["id"], owner=owner))

        return [t("bot_deleted", self.lang, n=await asyncio.to_thread(run))]

    async def memory_hint(self, user_id: int, query: str) -> str:
        hits = await asyncio.to_thread(self.runtime.memory(owner_of(user_id)), query)
        return memory_context(hits)[0]


def looks_like_transcript(text: str) -> bool:
    segments = parse_transcript(text)
    return len(segments) >= 2 or (len(segments) == 1 and bool(segments[0].speaker) and len(text) > 200)


def is_chatter(text: str) -> bool:
    """"ок", "спасибо", "👍" must not trigger paid research."""
    words = re.findall(r"\w+", text)
    return len(words) < MIN_QUESTION_WORDS and not text.strip().endswith("?")


# --- Telegram adapters ---------------------------------------------------------

async def _reply(update, messages: list[str]) -> None:
    for msg in messages:
        try:
            await update.effective_message.reply_text(msg, parse_mode="HTML", disable_web_page_preview=True)
        except Exception as exc:  # e.g. Telegram rejected the markup: send plain text instead
            log.warning("HTML reply failed (%s), sending plain text", exc)
            plain = html.unescape(re.sub(r"<[^>]+>", "", msg))
            await update.effective_message.reply_text(plain, disable_web_page_preview=True)


def make_handlers(service: BotService):
    lang = lambda: service.lang  # noqa: E731

    async def guard(update) -> bool:
        if not service.allowed(update.effective_user.id):
            await update.effective_message.reply_text(t("bot_denied", lang()))
            return False
        return True

    async def start(update, context) -> None:
        if await guard(update):
            await update.effective_message.reply_text(t("bot_help", lang()))

    async def ask(update, context) -> None:
        if await guard(update):
            await _reply(update, await service.ask(update.effective_user.id, " ".join(context.args or [])))

    async def last(update, context) -> None:
        if await guard(update):
            await _reply(update, await service.last(update.effective_user.id))

    async def history(update, context) -> None:
        if await guard(update):
            await _reply(update, await service.history(update.effective_user.id))

    async def delete(update, context) -> None:
        if await guard(update):
            await _reply(update, await service.delete_all(update.effective_user.id))

    async def text(update, context) -> None:
        if not await guard(update):
            return
        body = update.effective_message.text or ""
        uid = update.effective_user.id
        if looks_like_transcript(body):
            await update.effective_message.reply_text(t("bot_processing", lang()))
            await _reply(update, await service.process_text(uid, body))
        elif is_chatter(body):
            await update.effective_message.reply_text(t("bot_short", lang()))
        else:
            await _reply(update, await service.ask(uid, body))

    async def document(update, context) -> None:
        if not await guard(update):
            return
        doc = update.effective_message.document
        suffix = Path(doc.file_name or "").suffix.lower()
        if suffix not in TRANSCRIPT_SUFFIXES:
            await update.effective_message.reply_text(t("bot_files", lang()))
            return
        if doc.file_size and doc.file_size > MAX_FILE_BYTES:
            await update.effective_message.reply_text(t("bot_too_big", lang()))
            return
        await update.effective_message.reply_text(t("bot_processing", lang()))
        tg_file = await doc.get_file()
        data = await tg_file.download_as_bytearray()
        title = Path(doc.file_name or "Встреча").stem[:200]
        await _reply(update, await service.process_text(update.effective_user.id,
                                                        bytes(data).decode("utf-8", "replace"), title))

    async def audio(update, context) -> None:
        if not await guard(update):
            return
        msg = update.effective_message
        media = msg.voice or msg.audio
        if media.file_size and media.file_size > MAX_FILE_BYTES:
            await msg.reply_text(t("bot_too_big", lang()))
            return
        await msg.reply_text(t("bot_recognizing", lang()))
        tg_file = await media.get_file()
        with tempfile.TemporaryDirectory() as tmp:  # the audio is deleted after recognition
            path = Path(tmp) / "audio.ogg"
            await tg_file.download_to_drive(custom_path=path)
            await _reply(update, await service.process_audio(update.effective_user.id, path))

    async def on_error(update, context) -> None:
        log.error("update failed", exc_info=context.error)
        if update is not None and getattr(update, "effective_message", None) is not None:
            await update.effective_message.reply_text(t("bot_failed", lang()))

    return {"start": start, "help": start, "ask": ask, "last": last, "history": history, "delete": delete,
            "text": text, "document": document, "audio": audio, "error": on_error}


def build_application(settings: Settings, service: BotService):
    from telegram.ext import Application, CommandHandler, MessageHandler, filters

    if not settings.telegram_token:
        raise SystemExit("Не задан TELEGRAM_BOT_TOKEN")
    if not settings.telegram_allowed_users and not settings.telegram_public:
        raise SystemExit("Задайте RECAPPER_TELEGRAM_ALLOWED_USERS (id через запятую) "
                         "или явно RECAPPER_TELEGRAM_PUBLIC=1 для публичного бота")
    h = make_handlers(service)
    app = Application.builder().token(settings.telegram_token).concurrent_updates(True).build()
    app.add_handler(CommandHandler(["start", "help"], h["start"]))
    app.add_handler(CommandHandler("ask", h["ask"]))
    app.add_handler(CommandHandler("last", h["last"]))
    app.add_handler(CommandHandler("history", h["history"]))
    app.add_handler(CommandHandler("delete", h["delete"]))
    app.add_handler(MessageHandler(filters.Document.ALL, h["document"]))
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, h["audio"]))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, h["text"]))
    app.add_error_handler(h["error"])
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    from ..prefs import PrefsStore, apply_prefs

    base = Settings.from_env()
    settings = apply_prefs(base, PrefsStore(base.db_path).load())
    runtime = Runtime(settings, ReportStore(settings.db_path, keep_segments=settings.store_segments))
    runtime.store.purge_older_than(settings.retention_days)
    build_application(settings, BotService(runtime)).run_polling()
