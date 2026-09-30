"""User-editable settings: one registry drives the API, validation and the UI form.

Values are stored in the same SQLite file as reports (table ``prefs``) and
override the environment defaults. Secrets are write-only: the API reports
only whether they are set.
"""

from __future__ import annotations

import dataclasses
import json
import math
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings

LANGS = [("ru", "Русский", "Russian"), ("en", "English", "English")]
ASR_LANGS = [("auto", "Автоопределение", "Auto-detect"), ("ru", "Русский", "Russian"), ("en", "English", "English"),
             ("uk", "Українська", "Ukrainian"), ("kk", "Қазақша", "Kazakh"), ("de", "Deutsch", "German"),
             ("fr", "Français", "French"), ("es", "Español", "Spanish")]


@dataclass(frozen=True)
class Field:
    key: str
    type: str  # enum | bool | int | float | str | secret | multi
    group: str
    label_ru: str
    label_en: str
    help_ru: str = ""
    help_en: str = ""
    options: tuple[tuple[str, str, str], ...] = ()  # (value, label_ru, label_en)
    min: float | None = None
    max: float | None = None
    scope: str = "server"  # server | ui | desktop (who consumes it)
    show_if: tuple[str, tuple[str, ...]] | None = None  # (other key, values) — hide the field otherwise


def _opts(*pairs: tuple[str, str, str]) -> tuple[tuple[str, str, str], ...]:
    return tuple(pairs)


FIELDS: tuple[Field, ...] = (
    # Language
    Field("ui_language", "enum", "language", "Язык интерфейса", "Interface language", options=tuple(LANGS), scope="ui"),
    Field("meeting_language", "enum", "language", "Язык встречи (распознавание речи)", "Meeting language (speech recognition)",
          "Автоопределение медленнее и ошибается на смешанной речи.", "Auto-detect is slower and less reliable on mixed speech.",
          options=tuple(ASR_LANGS)),
    Field("answer_language", "enum", "language", "Язык ответов ассистента", "Assistant answer language",
          options=_opts(("auto", "Как на встрече", "Same as meeting"), ("ru", "Русский", "Russian"), ("en", "English", "English"))),
    # AI
    Field("llm_provider", "enum", "ai", "Провайдер ИИ", "AI provider",
          "«Авто»: Claude, если задан ключ; иначе OpenAI-совместимый сервер; иначе офлайн.",
          "Auto: Claude if a key is set, otherwise an OpenAI-compatible server, otherwise offline.",
          options=_opts(("auto", "Авто", "Auto"), ("claude", "Claude (Anthropic)", "Claude (Anthropic)"),
                        ("openai", "OpenAI-совместимый (OpenAI, Gemini-прокси, Ollama, LM Studio…)", "OpenAI-compatible (OpenAI, Gemini proxy, Ollama, LM Studio…)"),
                        ("none", "Без ИИ (офлайн)", "No AI (offline)"),
                        ("sim-good", "Симуляция: хороший ИИ", "Simulation: good AI"),
                        ("sim-sloppy", "Симуляция: неаккуратный ИИ", "Simulation: sloppy AI"),
                        ("sim-broken", "Симуляция: сломанный ИИ", "Simulation: broken AI"))),
    Field("anthropic_api_key", "secret", "ai", "Ключ Anthropic API", "Anthropic API key",
          "Ключ из console.anthropic.com (подписка Claude.ai не подходит).", "Key from console.anthropic.com (a Claude.ai subscription does not work).",
          show_if=("llm_provider", ("auto", "claude"))),
    Field("model", "enum", "ai", "Модель Claude", "Claude model",
          options=_opts(("claude-opus-5-5", "Claude Opus 5.5 (рекомендуется)", "Claude Opus 5.5 (recommended)"),
                        ("claude-sonnet-5-5", "Claude Sonnet 5.5 (быстрее, дешевле)", "Claude Sonnet 5.5 (faster, cheaper)"),
                        ("claude-fable-5-1", "Claude Fable 5.1 (самая сильная, дорогая)", "Claude Fable 5.1 (most capable, costly)")),
          show_if=("llm_provider", ("auto", "claude"))),
    Field("answer_effort", "enum", "ai", "Глубина проработки ответов", "Answer effort",
          options=_opts(("low", "Низкая", "Low"), ("medium", "Средняя", "Medium"), ("high", "Высокая", "High"),
                        ("xhigh", "Очень высокая", "Very high"), ("max", "Максимальная", "Max")),
          show_if=("llm_provider", ("auto", "claude"))),
    Field("detect_effort", "enum", "ai", "Глубина поиска вопросов", "Detection effort",
          options=_opts(("low", "Низкая", "Low"), ("medium", "Средняя", "Medium"), ("high", "Высокая", "High")),
          show_if=("llm_provider", ("auto", "claude"))),
    Field("web_search", "bool", "ai", "Веб-поиск в ответах", "Web search in answers",
          "Только для Claude. Отключите для конфиденциальных встреч.", "Claude only. Turn off for confidential meetings.",
          show_if=("llm_provider", ("auto", "claude"))),
    Field("web_search_max_uses", "int", "ai", "Максимум поисков на ответ", "Max searches per answer", min=1, max=20,
          show_if=("llm_provider", ("auto", "claude"))),
    Field("openai_base_url", "str", "ai", "Адрес сервера (base URL)", "Server base URL",
          "Например http://127.0.0.1:8045/v1 (прокси), https://api.openai.com/v1, http://localhost:11434/v1 (Ollama). "
          "Если /v1 не указан, он добавится сам.",
          "e.g. http://127.0.0.1:8045/v1 (proxy), https://api.openai.com/v1, http://localhost:11434/v1 (Ollama). "
          "/v1 is added if missing.", show_if=("llm_provider", ("auto", "openai"))),
    Field("openai_api_key", "secret", "ai", "API-ключ сервера", "Server API key",
          "Для Ollama/LM Studio можно оставить пустым.", "May be empty for Ollama/LM Studio.", show_if=("llm_provider", ("auto", "openai"))),
    Field("openai_model", "str", "ai", "Модель", "Model",
          "Нажмите «Проверить подключение», чтобы выбрать из списка моделей сервера.",
          "Press “Test connection” to pick from the server's model list.", show_if=("llm_provider", ("auto", "openai"))),
    # Assistant
    Field("wake_words", "str", "assistant", "Слова-обращения к ассистенту", "Wake words",
          "Через запятую. Фраза «Ассистент, посчитай…» станет задачей.", "Comma-separated. “Assistant, calculate…” becomes a task."),
    Field("auto_answer", "enum", "assistant", "Что отвечать автоматически", "Answer automatically",
          options=_opts(("commands", "Только мои задачи (голосом и текстом)", "Only my tasks (voice and typed)"),
                        ("all", "Также вопросы, прозвучавшие на встрече", "Also questions heard in the meeting"))),
    Field("suggestions_enabled", "bool", "assistant", "Находить вопросы и задачи в разговоре", "Find questions and tasks in the conversation"),
    Field("max_answers", "int", "assistant", "Лимит ответов на встречу", "Max answers per meeting", min=1, max=200),
    Field("detect_min_chars", "int", "assistant", "Как часто искать вопросы (символов речи)", "Detection interval (characters of speech)",
          "Меньше — быстрее подсказки, но больше запросов к ИИ.", "Lower is faster but costs more AI calls.", min=100, max=5000),
    Field("default_template", "enum", "assistant", "Шаблон отчёта по умолчанию", "Default report template", options=()),
    Field("assist_actions", "multi", "assistant", "Быстрые действия во время встречи", "Live Assist actions",
          options=_opts(("catch_up", "Догнать", "Catch up"), ("summary", "Итог сейчас", "Summary so far"),
                        ("followups", "Что спросить", "Follow-up questions"), ("actions", "Поручения", "Action items"),
                        ("topics", "Темы", "Topics"))),
    Field("me_label", "str", "assistant", "Как подписывать мой микрофон", "Label for my microphone"),
    Field("others_label", "str", "assistant", "Как подписывать собеседников", "Label for other participants"),
    # Capture
    Field("asr_provider", "enum", "capture", "Распознавание речи", "Speech recognition",
          "faster-whisper работает локально, звук не покидает компьютер.", "faster-whisper runs locally; audio never leaves the computer.",
          options=_opts(("faster-whisper", "Локально (faster-whisper)", "Local (faster-whisper)"), ("none", "Выключено", "Off"))),
    Field("whisper_model", "enum", "capture", "Модель распознавания", "Recognition model",
          "Больше — точнее, но медленнее. На ноутбуке без видеокарты берите small.", "Larger is more accurate but slower.",
          options=_opts(("tiny", "tiny (быстро)", "tiny (fast)"), ("base", "base", "base"), ("small", "small (баланс)", "small (balanced)"),
                        ("medium", "medium", "medium"), ("large-v3", "large-v3 (точно, медленно)", "large-v3 (accurate, slow)")),
          show_if=("asr_provider", ("faster-whisper",))),
    Field("capture_sources", "multi", "capture", "Что записывать", "Capture sources", scope="desktop",
          options=_opts(("mic", "Мой микрофон", "My microphone"), ("system", "Звук собеседников (системный)", "Other participants (system audio)"))),
    Field("capture_chunk_seconds", "int", "capture", "Длина фрагмента, сек", "Chunk length, s",
          "Меньше — быстрее появляется текст.", "Shorter means faster transcripts.", min=4, max=60, scope="desktop"),
    Field("capture_silence_threshold", "float", "capture", "Порог тишины", "Silence threshold", min=0.0, max=0.1, scope="desktop"),
    # Desktop
    Field("panel_hotkey", "str", "desktop", "Горячая клавиша панели", "Panel hotkey", scope="desktop"),
    Field("panel_always_on_top", "bool", "desktop", "Панель поверх окон", "Panel always on top", scope="desktop"),
    Field("panel_hide_from_screen_share", "bool", "desktop", "Скрывать панель при демонстрации экрана", "Hide panel from screen sharing", scope="desktop"),
    Field("theme", "enum", "desktop", "Тема", "Theme", scope="ui",
          options=_opts(("system", "Как в системе", "System"), ("light", "Светлая", "Light"), ("dark", "Тёмная", "Dark"))),
    # Privacy
    Field("store_segments", "bool", "privacy", "Хранить расшифровки", "Keep transcripts",
          "Без расшифровок память прошлых встреч работает только по итогам.", "Without transcripts, memory uses only recaps."),
    Field("retention_days", "int", "privacy", "Удалять встречи старше, дней (0 — хранить)", "Delete meetings older than, days (0 = keep)",
          min=0, max=3650),
)

GROUPS = {"language": ("Язык", "Language"), "ai": ("ИИ", "AI"), "assistant": ("Ассистент", "Assistant"),
          "capture": ("Запись и распознавание", "Capture and recognition"), "desktop": ("Оформление и приложение", "Appearance and app"),
          "privacy": ("Данные и приватность", "Data and privacy")}
FIELD_BY_KEY = {f.key: f for f in FIELDS}
_RESTART_KEYS = {"asr_provider", "whisper_model", "meeting_language"}


class SettingsError(ValueError):
    pass


def _coerce(f: Field, value: Any) -> Any:
    if f.type == "bool":
        if not isinstance(value, bool):
            raise SettingsError(f"{f.key}: ожидается true/false")
        return value
    if f.type in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise SettingsError(f"{f.key}: ожидается число")
        if f.type == "int" and float(value) != int(value):
            raise SettingsError(f"{f.key}: ожидается целое число")
        value = int(value) if f.type == "int" else float(value)
        if (f.min is not None and value < f.min) or (f.max is not None and value > f.max):
            raise SettingsError(f"{f.key}: допустимо от {f.min} до {f.max}")
        return value
    if f.type == "multi":
        allowed = {o[0] for o in f.options}
        if not isinstance(value, list) or not all(isinstance(v, str) and v in allowed for v in value):
            raise SettingsError(f"{f.key}: допустимые значения {sorted(allowed)}")
        return list(dict.fromkeys(value))
    if not isinstance(value, str):
        raise SettingsError(f"{f.key}: ожидается строка")
    value = value.strip()
    if len(value) > 500:
        raise SettingsError(f"{f.key}: слишком длинное значение")
    if f.type == "enum":
        options = _enum_options(f)
        if value not in {o[0] for o in options}:
            raise SettingsError(f"{f.key}: допустимые значения {[o[0] for o in options]}")
    if f.key == "openai_base_url" and value and not value.startswith(("http://", "https://")):
        raise SettingsError("openai_base_url: адрес должен начинаться с http:// или https://")
    if f.key == "wake_words" and not [w for w in value.split(",") if w.strip()]:
        raise SettingsError("wake_words: нужно хотя бы одно слово")
    return value


def _enum_options(f: Field) -> tuple[tuple[str, str, str], ...]:
    if f.key == "default_template":
        from .assist import TEMPLATES

        return tuple((t.id, t.name, t.id.replace("_", " ").title()) for t in TEMPLATES.values())
    return f.options


class PrefsStore:
    def __init__(self, db_path: Path | str):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute("CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self._conn.commit()

    def load(self) -> dict[str, Any]:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM prefs").fetchall()
        out = {}
        for key, raw in rows:
            if key in FIELD_BY_KEY:
                try:
                    out[key] = json.loads(raw)
                except json.JSONDecodeError:
                    continue
        return out

    def save(self, values: dict[str, Any]) -> None:
        with self._lock:
            for key, value in values.items():
                if value is None:
                    self._conn.execute("DELETE FROM prefs WHERE key = ?", (key,))
                else:
                    self._conn.execute("INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)",
                                       (key, json.dumps(value, ensure_ascii=False)))
            self._conn.commit()

    def close(self) -> None:
        self._conn.close()


def apply_prefs(base: Settings, prefs: dict[str, Any]) -> Settings:
    updates = {k: v for k, v in prefs.items() if k in FIELD_BY_KEY and hasattr(base, k)}
    return dataclasses.replace(base, **updates)


def validate_update(values: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise SettingsError("ожидается объект values")
    clean: dict[str, Any] = {}
    for key, value in values.items():
        f = FIELD_BY_KEY.get(key)
        if f is None:
            raise SettingsError(f"неизвестная настройка: {key}")
        if value is None:  # reset to default
            clean[key] = None
            continue
        clean[key] = _coerce(f, value)
    return clean


def public_values(settings: Settings) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in FIELDS:
        value = getattr(settings, f.key)
        if f.type == "secret":
            out[f.key] = {"set": bool(value)}
        elif isinstance(value, Path):
            out[f.key] = str(value)
        else:
            out[f.key] = value
    out["has_claude_env_key"] = settings.has_claude
    return out


def schema() -> list[dict]:
    return [
        {
            "key": f.key, "type": f.type, "group": f.group, "group_label": {"ru": GROUPS[f.group][0], "en": GROUPS[f.group][1]},
            "label": {"ru": f.label_ru, "en": f.label_en}, "help": {"ru": f.help_ru, "en": f.help_en},
            "options": [{"value": v, "label": {"ru": r, "en": e}} for v, r, e in _enum_options(f)],
            "min": f.min, "max": f.max, "scope": f.scope, "restart": f.key in _RESTART_KEYS,
            "show_if": {"key": f.show_if[0], "values": list(f.show_if[1])} if f.show_if else None,
        }
        for f in FIELDS
    ]


AI_KEYS = {"llm_provider", "anthropic_api_key", "model", "openai_base_url", "openai_api_key", "openai_model",
           "web_search_max_uses"}
