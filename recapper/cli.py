"""Command line: process a transcript/audio file into a Markdown report."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .asr import ASRError, get_transcriber
from .config import Settings
from .engine import build_components, process_segments
from .knowledge import KnowledgeBase
from .render import report_to_markdown
from .transcript import parse_transcript

AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".webm", ".mp4"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="recapper", description="Итоги встречи + черновики ответов на прозвучавшие вопросы")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("process", help="обработать расшифровку или аудио")
    p.add_argument("file", type=Path)
    p.add_argument("--title", default=None)
    p.add_argument("--kb", type=Path, default=None, help="папка с материалами компании (.md/.txt)")
    p.add_argument("--ask", action="append", default=[], help="дополнительный вопрос (можно несколько)")
    p.add_argument("--out", type=Path, default=None, help="куда сохранить Markdown (по умолчанию stdout)")
    p.add_argument("--no-web", action="store_true", help="не использовать веб-поиск")
    sub.add_parser("web", help="запустить веб-интерфейс на http://127.0.0.1:8000")
    sub.add_parser("bot", help="запустить Telegram-бота")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    if args.cmd == "web":
        from .web.app import main as web_main

        web_main()
        return 0
    if args.cmd == "bot":
        from .bot.telegram_bot import main as bot_main

        bot_main()
        return 0

    settings = Settings.from_env()
    if args.no_web:
        settings.web_search = False
    if not args.file.is_file():
        print(f"Файл не найден: {args.file}", file=sys.stderr)
        return 2
    if args.file.suffix.lower() in AUDIO_SUFFIXES:
        try:
            transcriber = get_transcriber(settings)
            if transcriber is None:
                print("Для аудио включите распознавание: RECAPPER_ASR=faster-whisper", file=sys.stderr)
                return 2
            segments = transcriber.transcribe(args.file)
        except ASRError as exc:
            print(str(exc), file=sys.stderr)
            return 2
    else:
        segments = parse_transcript(args.file.read_text("utf-8", errors="replace"))
    if not segments:
        print("В файле не найдено реплик.", file=sys.stderr)
        return 2
    title = args.title or args.file.stem
    kb = KnowledgeBase.from_dir(args.kb or settings.knowledge_dir)
    components = build_components(settings, kb=kb, title=title)
    if components.mode == "offline":
        print("Внимание: ANTHROPIC_API_KEY не задан — офлайн-режим, черновики ответов не генерируются.",
              file=sys.stderr)
    report = process_segments(segments, components, title=title, questions=args.ask)
    markdown = report_to_markdown(report)
    if args.out:
        args.out.write_text(markdown, "utf-8")
        print(f"Отчёт сохранён: {args.out} (вопросов и задач: {len(report.items)})", file=sys.stderr)
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
