"""Command line: process files, run the server/bot, evaluate AI providers."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .asr import ASRError, get_transcriber
from .config import Settings
from .engine import Runtime, process_segments
from .knowledge import KnowledgeBase
from .render import report_to_markdown
from .store import ReportStore
from .transcript import parse_transcript

AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".webm", ".mp4"}
ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="recapper", description="Ассистент встреч: итоги + ответы на ваши задачи")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("process", help="обработать расшифровку или аудио")
    p.add_argument("file", type=Path)
    p.add_argument("--title", default=None)
    p.add_argument("--kb", type=Path, default=None, help="папка с материалами компании (.md/.txt/.csv)")
    p.add_argument("--ask", action="append", default=[], help="дополнительный вопрос (можно несколько)")
    p.add_argument("--out", type=Path, default=None, help="куда сохранить Markdown (по умолчанию stdout)")
    p.add_argument("--no-web", action="store_true", help="не использовать веб-поиск")
    p.add_argument("--answer-all", action="store_true", help="отвечать и на вопросы, прозвучавшие на встрече")
    p.add_argument("--template", default="general", help="шаблон отчёта (general, protocol, product, ...)")
    p.add_argument("--lang", default="ru", choices=["ru", "en"], help="язык отчёта")
    p.add_argument("--provider", default=None, help="ИИ: claude | openai | none | sim-good | sim-sloppy | sim-broken")
    p.add_argument("--db", type=Path, default=None, help="база для памяти прошлых встреч")

    s = sub.add_parser("serve", help="запустить сервер и веб-интерфейс (используется десктоп-приложением)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--token", default=None, help="токен доступа; если не задан — сгенерируется")
    s.add_argument("--data-dir", type=Path, default=None, help="папка данных (по умолчанию ~/.recapper)")
    sub.add_parser("web", help="то же, что serve с настройками по умолчанию")
    sub.add_parser("bot", help="запустить Telegram-бота")

    e = sub.add_parser("eval", help="оценить провайдера ИИ на эталонных встречах (с перехватом всех ответов)")
    e.add_argument("--provider", default=None)
    e.add_argument("--scenarios", type=Path, default=ROOT / "examples" / "eval")
    e.add_argument("--kb", type=Path, default=ROOT / "examples" / "knowledge")
    e.add_argument("--workdir", type=Path, default=Path("eval-out"))
    e.add_argument("--strict", action="store_true", help="код выхода 1, если хоть один сценарий не прошёл")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    if args.cmd in ("serve", "web"):
        from .web.app import serve

        if args.cmd == "web":
            serve()
        else:
            serve(args.host, args.port, args.token, args.data_dir)
        return 0
    if args.cmd == "bot":
        from .bot.telegram_bot import main as bot_main

        bot_main()
        return 0
    if args.cmd == "eval":
        from .evaluate import format_results, run_eval

        settings = Settings.from_env()
        if args.provider:
            settings.llm_provider = args.provider
        results = run_eval(settings, args.scenarios, args.kb, args.workdir)
        text = format_results(results, settings.llm_provider)
        (args.workdir / "report.md").write_text(text, "utf-8")
        print(text)
        print(f"Перехват всех вызовов ИИ: {args.workdir / 'trace.jsonl'}", file=sys.stderr)
        return 1 if args.strict and not all(r.passed for r in results) else 0

    return _process(args)


def _process(args: argparse.Namespace) -> int:
    settings = Settings.from_env()
    if args.no_web:
        settings.web_search = False
    if args.provider:
        settings.llm_provider = args.provider
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
    store = ReportStore(args.db or ":memory:")
    runtime = Runtime(settings, store, kb=KnowledgeBase.from_dir(args.kb or settings.knowledge_dir))
    if runtime.llm_error:
        print(f"ИИ недоступен: {runtime.llm_error}", file=sys.stderr)
    if runtime.mode == "offline":
        print("Внимание: ИИ не подключён (нет ANTHROPIC_API_KEY) — офлайн-режим, черновики ответов не генерируются.",
              file=sys.stderr)
    components = runtime.components(title, owner="cli", template=args.template)
    report = process_segments(segments, components, title=title, questions=args.ask,
                              auto_answer="all" if args.answer_all else "commands", template=args.template)
    if args.db:
        store.save(report, owner="cli")
    markdown = report_to_markdown(report, args.lang)
    if args.out:
        args.out.write_text(markdown, "utf-8")
        print(f"Отчёт сохранён: {args.out} (пунктов: {len(report.items)})", file=sys.stderr)
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
