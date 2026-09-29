"""Server-side strings (reports, bot) in the supported interface languages."""

from __future__ import annotations

SUPPORTED = ("ru", "en")

_T: dict[str, dict[str, str]] = {
    "recap": {"ru": "Итог", "en": "Summary"},
    "decisions": {"ru": "Решения", "en": "Decisions"},
    "action_items": {"ru": "Поручения", "en": "Action items"},
    "my_tasks": {"ru": "Мои задачи ассистенту", "en": "My tasks for the assistant"},
    "heard": {"ru": "Прозвучало на встрече", "en": "Heard in the meeting"},
    "nothing_found": {"ru": "Ничего не найдено.", "en": "Nothing found."},
    "question": {"ru": "Вопрос", "en": "Question"},
    "task": {"ru": "Задача", "en": "Task"},
    "by_voice": {"ru": "голосом", "en": "by voice"},
    "typed": {"ru": "от вас", "en": "typed by you"},
    "possible": {"ru": "возможно", "en": "possible"},
    "preparing": {"ru": "готовится…", "en": "in progress…"},
    "not_requested": {"ru": "ответ не запрашивался", "en": "answer not requested"},
    "failed": {"ru": "не удалось подготовить ответ", "en": "could not prepare an answer"},
    "offline": {"ru": "ИИ не подключён: собран контекст, черновика нет", "en": "No AI connected: context only, no draft"},
    "confidence": {"ru": "уверенность", "en": "confidence"},
    "check_before_sending": {"ru": "проверьте перед отправкой", "en": "check before sending"},
    "high": {"ru": "высокая", "en": "high"},
    "medium": {"ru": "средняя", "en": "medium"},
    "low": {"ru": "низкая", "en": "low"},
    "short": {"ru": "Коротко", "en": "In short"},
    "assumptions": {"ru": "Допущения", "en": "Assumptions"},
    "ai_check": {"ru": "Проверка ответа ИИ", "en": "AI answer check"},
    "sources": {"ru": "Источники", "en": "Sources"},
    "mode": {"ru": "Режим", "en": "Mode"},
    "footer": {"ru": "Черновики сгенерированы ИИ и требуют проверки.", "en": "Drafts are AI-generated; review them."},
    "found_items": {"ru": "Задач и вопросов", "en": "Tasks and questions"},
    "template": {"ru": "Шаблон", "en": "Template"},
    # bot
    "bot_help": {
        "ru": "Я слушаю встречи и решаю задачи, которые вы ставите по ходу.\n\n"
              "• Во время встречи скажите «Ассистент, …» — например «Ассистент, допиши механику монетизации» — "
              "и ответ появится в итоге встречи.\n"
              "• Пришлите расшифровку текстом или файлом (.txt, .vtt, .srt) — верну итог и ответы на ваши задачи.\n"
              "• Пришлите голосовое — распознаю и выполню задачу.\n"
              "• /ask вопрос — спросить с учётом всех ваших встреч.\n"
              "• /last — последний отчёт, /history — список встреч, /delete — удалить все мои данные.\n\n"
              "Записывайте встречи только с согласия участников. Аудио не сохраняется.",
        "en": "I listen to meetings and solve the tasks you set along the way.\n\n"
              "• During a meeting say “Assistant, …” and the answer appears in the meeting summary.\n"
              "• Send a transcript as text or a file (.txt, .vtt, .srt).\n"
              "• Send a voice note and I will do the task.\n"
              "• /ask question — ask with all your meetings in mind.\n"
              "• /last, /history, /delete — last report, meeting list, delete all my data.\n\n"
              "Record meetings only with participants' consent. Audio is not stored.",
    },
    "bot_denied": {"ru": "Доступ ограничен.", "en": "Access denied."},
    "bot_processing": {"ru": "Обрабатываю встречу…", "en": "Processing the meeting…"},
    "bot_recognizing": {"ru": "Распознаю…", "en": "Transcribing…"},
    "bot_no_segments": {"ru": "Не нашёл в тексте реплик. Формат: «Имя: реплика», VTT или SRT.",
                        "en": "No utterances found. Format: “Name: text”, VTT or SRT."},
    "bot_no_asr": {"ru": "Распознавание речи не включено на сервере. Пришлите расшифровку текстом или файлом.",
                   "en": "Speech recognition is off on the server. Send a transcript instead."},
    "bot_no_speech": {"ru": "В аудио не распознано речи.", "en": "No speech recognised in the audio."},
    "bot_ask_empty": {"ru": "Напишите вопрос после /ask.", "en": "Write a question after /ask."},
    "bot_no_reports": {"ru": "Отчётов пока нет. Пришлите расшифровку.", "en": "No reports yet. Send a transcript."},
    "bot_files": {"ru": "Поддерживаются файлы .txt, .vtt, .srt, .md.", "en": "Supported files: .txt, .vtt, .srt, .md."},
    "bot_too_big": {"ru": "Файл больше 20 МБ.", "en": "The file is larger than 20 MB."},
    "bot_short": {"ru": "Напишите вопрос подробнее или пришлите расшифровку встречи.",
                  "en": "Please write a fuller question or send a meeting transcript."},
    "bot_deleted": {"ru": "Удалено встреч: {n}.", "en": "Meetings deleted: {n}."},
    "bot_failed": {"ru": "Не получилось обработать сообщение. Попробуйте ещё раз.", "en": "Something went wrong. Please try again."},
    "bot_history_empty": {"ru": "Встреч пока нет.", "en": "No meetings yet."},
    "bot_suggest": {"ru": "Можно спросить дальше:", "en": "You could ask next:"},
}


def t(key: str, lang: str = "ru", **kwargs: object) -> str:
    entry = _T.get(key)
    if entry is None:
        return key
    text = entry.get(lang) or entry["ru"]
    return text.format(**kwargs) if kwargs else text


def language_instruction(answer_language: str) -> str:
    """Appended to prompts (after the shared prefix, so caching still works)."""
    if answer_language == "ru":
        return "Язык ответа: русский."
    if answer_language == "en":
        return "Answer language: English."
    return "Язык ответа: тот же, что у встречи."
