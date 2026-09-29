"""Telegram bot: send a transcript, a file or a voice note, get answers back.

The bot cannot listen to a Zoom/Телемост call by itself; it is the delivery
and quick-question channel. Logic lives in ``BotService`` (easy to test);
the handlers only translate Telegram updates.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Callable

from ..asr import ASRError, Transcriber, get_transcriber
from ..config import Settings
from ..engine import Components, build_components, process_segments
from ..models import AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport
from ..render import item_to_telegram, report_to_telegram, split_message
from ..store import ReportStore
from ..transcript import parse_transcript

log = logging.getLogger(__name__)

TRANSCRIPT_SUFFIXES = {".txt", ".vtt", ".srt", ".md"}
MAX_FILE_BYTES = 20 * 1024 * 1024  # Bot API download limit

HELP = (
    "Я превращаю встречу в ответы.\n\n"
    "• Пришлите расшифровку текстом или файлом (.txt, .vtt, .srt) — верну итог, найденные "
    "вопросы и задачи и черновики ответов по ним.\n"
    "• Пришлите голосовое или аудио — распознаю и обработаю (если включено распознавание).\n"
    "• /ask вопрос — спросить в контексте последней встречи. Одна строка без «Имя:» тоже считается вопросом.\n"
    "• /last — повторить последний отчёт.\n\n"
    "Записывайте встречи только с согласия участников. Аудио не сохраняется."
)


class BotService:
    def __init__(self, settings: Settings, store: ReportStore,
                 components_factory: Callable[[str], Components] | None = None,
                 transcriber: Transcriber | None = None):
        self.settings = settings
        self.store = store
        self.factory = components_factory or (lambda title: build_components(settings, title=title))
        self._transcriber = transcriber

    def allowed(self, user_id: int) -> bool:
        return not self.settings.telegram_allowed_users or user_id in self.settings.telegram_allowed_users

    def transcriber(self) -> Transcriber | None:
        if self._transcriber is None:
            self._transcriber = get_transcriber(self.settings)
        return self._transcriber

    async def process_text(self, user_id: int, text: str, title: str = "Встреча") -> list[str]:
        segments = parse_transcript(text)
        if not segments:
            return ["Не нашёл в тексте реплик. Формат: «Имя: реплика», VTT или SRT."]
        report = await asyncio.to_thread(process_segments, segments, self.factory(title), title)
        self.store.save(report, owner=str(user_id))
        return report_to_telegram(report)

    async def process_audio(self, user_id: int, path: Path, title: str = "Голосовая заметка") -> list[str]:
        try:
            transcriber = self.transcriber()
        except ASRError as exc:
            return [f"Распознавание недоступно: {exc}"]
        if transcriber is None:
            return ["Распознавание речи не включено на сервере. Пришлите расшифровку текстом или файлом."]
        try:
            segments = await asyncio.to_thread(transcriber.transcribe, path)
        except ASRError as exc:
            return [str(exc)]
        if not segments:
            return ["В аудио не распознано речи."]
        report = await asyncio.to_thread(process_segments, segments, self.factory(title), title)
        self.store.save(report, owner=str(user_id))
        return report_to_telegram(report)

    async def ask(self, user_id: int, question: str) -> list[str]:
        question = question.strip()
        if len(question) < 2:
            return ["Напишите вопрос после /ask."]
        report = self.store.latest(str(user_id)) or MeetingReport(title="Вопросы без встречи")
        components = self.factory(report.title)
        item = Item(kind=ItemKind.QUESTION, text=question, origin=ItemOrigin.USER)
        answer = await asyncio.to_thread(components.answerer.answer, item, report.segments)
        report.mode = components.mode
        report.items.append(item)
        report.answers.append(answer)
        self.store.save(report, owner=str(user_id))
        text = item_to_telegram(len(report.items), item, answer)
        if answer.status == AnswerStatus.FAILED:
            text += "\n\nПопробуйте ещё раз позже."
        return split_message(text)

    def last(self, user_id: int) -> list[str]:
        report = self.store.latest(str(user_id))
        return report_to_telegram(report) if report else ["Отчётов пока нет. Пришлите расшифровку."]


def looks_like_transcript(text: str) -> bool:
    segments = parse_transcript(text)
    return len(segments) >= 2 or any(s.speaker for s in segments)


# --- Telegram adapters ---------------------------------------------------------

async def _reply(update, messages: list[str]) -> None:
    for msg in messages:
        await update.effective_message.reply_text(msg, parse_mode="HTML", disable_web_page_preview=True)


def make_handlers(service: BotService):
    async def guard(update) -> bool:
        if not service.allowed(update.effective_user.id):
            await update.effective_message.reply_text("Доступ ограничен.")
            return False
        return True

    async def start(update, context) -> None:
        if await guard(update):
            await update.effective_message.reply_text(HELP)

    async def ask(update, context) -> None:
        if not await guard(update):
            return
        question = " ".join(context.args or [])
        await _reply(update, await service.ask(update.effective_user.id, question))

    async def last(update, context) -> None:
        if await guard(update):
            await _reply(update, service.last(update.effective_user.id))

    async def text(update, context) -> None:
        if not await guard(update):
            return
        body = update.effective_message.text or ""
        uid = update.effective_user.id
        if looks_like_transcript(body):
            await update.effective_message.reply_text("Обрабатываю встречу…")
            await _reply(update, await service.process_text(uid, body))
        else:
            await _reply(update, await service.ask(uid, body))

    async def document(update, context) -> None:
        if not await guard(update):
            return
        doc = update.effective_message.document
        suffix = Path(doc.file_name or "").suffix.lower()
        if suffix not in TRANSCRIPT_SUFFIXES:
            await update.effective_message.reply_text("Поддерживаются файлы .txt, .vtt, .srt, .md.")
            return
        if doc.file_size and doc.file_size > MAX_FILE_BYTES:
            await update.effective_message.reply_text("Файл больше 20 МБ.")
            return
        await update.effective_message.reply_text("Обрабатываю встречу…")
        tg_file = await doc.get_file()
        data = await tg_file.download_as_bytearray()
        title = Path(doc.file_name or "Встреча").stem
        await _reply(update, await service.process_text(update.effective_user.id, bytes(data).decode("utf-8", "replace"), title))

    async def audio(update, context) -> None:
        if not await guard(update):
            return
        msg = update.effective_message
        media = msg.voice or msg.audio
        if media.file_size and media.file_size > MAX_FILE_BYTES:
            await msg.reply_text("Файл больше 20 МБ.")
            return
        await msg.reply_text("Распознаю…")
        tg_file = await media.get_file()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audio.ogg"
            await tg_file.download_to_drive(custom_path=path)
            await _reply(update, await service.process_audio(update.effective_user.id, path))

    return {"start": start, "help": start, "ask": ask, "last": last, "text": text,
            "document": document, "audio": audio}


def build_application(settings: Settings, service: BotService):
    from telegram.ext import Application, CommandHandler, MessageHandler, filters

    if not settings.telegram_token:
        raise SystemExit("Не задан TELEGRAM_BOT_TOKEN")
    h = make_handlers(service)
    app = Application.builder().token(settings.telegram_token).concurrent_updates(True).build()
    app.add_handler(CommandHandler(["start", "help"], h["start"]))
    app.add_handler(CommandHandler("ask", h["ask"]))
    app.add_handler(CommandHandler("last", h["last"]))
    app.add_handler(MessageHandler(filters.Document.ALL, h["document"]))
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, h["audio"]))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, h["text"]))
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = Settings.from_env()
    service = BotService(settings, ReportStore(settings.db_path, keep_segments=settings.store_segments))
    build_application(settings, service).run_polling()
