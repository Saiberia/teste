"""Runtime settings.

Defaults come from environment variables (server / CI deployments); users
override them from the settings screen (see ``prefs.py``), which is how the
desktop app is configured.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    # Language
    ui_language: str = "ru"  # ru | en
    meeting_language: str = "ru"  # ASR language: auto | ru | en | ...
    answer_language: str = "auto"  # auto (language of the meeting) | ru | en
    # AI provider: auto | claude | openai | none | sim-good | sim-sloppy | sim-broken
    llm_provider: str = "auto"
    anthropic_api_key: str = ""  # optional; env ANTHROPIC_API_KEY also works
    openai_base_url: str = ""
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    trace_path: Path | None = None  # JSONL log of every model call (interception)
    # Claude
    model: str = "claude-opus-5-5"
    detect_effort: str = "low"
    answer_effort: str = "high"
    web_search: bool = True
    web_search_max_uses: int = 5
    # Assistant behaviour
    wake_words: str = "ассистент, рекапер, помощник, assistant"
    auto_answer: str = "commands"  # commands (voice + typed) | all (also questions heard in the meeting)
    max_answers: int = 30
    suggestions_enabled: bool = True  # detect questions/tasks voiced in the conversation
    detect_min_chars: int = 600
    default_template: str = "general"
    assist_actions: list[str] = field(default_factory=lambda: ["catch_up", "summary", "followups", "actions", "topics"])
    me_label: str = "Я"
    others_label: str = "Собеседники"
    # Storage / knowledge
    db_path: Path = Path("recapper.db")
    knowledge_dir: Path | None = None
    store_segments: bool = True
    retention_days: int = 0  # 0 = keep forever
    # ASR
    asr_provider: str = "none"  # none | faster-whisper
    whisper_model: str = "small"
    # Desktop / capture (read by the desktop app and capture.js)
    capture_chunk_seconds: int = 12
    capture_sources: list[str] = field(default_factory=lambda: ["mic", "system"])
    capture_silence_threshold: float = 0.004
    panel_hotkey: str = "CommandOrControl+Shift+R"
    panel_always_on_top: bool = True
    panel_hide_from_screen_share: bool = True
    theme: str = "system"  # system | light | dark
    # Telegram
    telegram_token: str = ""
    telegram_allowed_users: set[int] = field(default_factory=set)
    telegram_public: bool = False

    @property
    def whisper_language(self) -> str:
        return "" if self.meeting_language == "auto" else self.meeting_language

    @property
    def has_claude(self) -> bool:
        return bool(self.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))

    @property
    def wake_word_list(self) -> tuple[str, ...]:
        words = tuple(w.strip().lower() for w in self.wake_words.split(",") if w.strip())
        # Common ASR misspelling of the default wake word.
        return words + (("асистент",) if "ассистент" in words else ())

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ.get
        kb = env("RECAPPER_KNOWLEDGE_DIR")
        allowed = env("RECAPPER_TELEGRAM_ALLOWED_USERS", "")
        trace = env("RECAPPER_TRACE")
        return cls(
            ui_language=env("RECAPPER_UI_LANGUAGE", cls.ui_language),
            meeting_language=env("RECAPPER_MEETING_LANGUAGE", env("RECAPPER_WHISPER_LANGUAGE", cls.meeting_language)),
            answer_language=env("RECAPPER_ANSWER_LANGUAGE", cls.answer_language),
            llm_provider=env("RECAPPER_LLM", "auto"),
            openai_base_url=env("OPENAI_BASE_URL", ""),
            openai_api_key=env("OPENAI_API_KEY", ""),
            openai_model=env("RECAPPER_OPENAI_MODEL", cls.openai_model),
            trace_path=Path(trace) if trace else None,
            model=env("RECAPPER_MODEL", cls.model),
            detect_effort=env("RECAPPER_DETECT_EFFORT", cls.detect_effort),
            answer_effort=env("RECAPPER_ANSWER_EFFORT", cls.answer_effort),
            web_search=_bool("RECAPPER_WEB_SEARCH", True),
            web_search_max_uses=int(env("RECAPPER_WEB_SEARCH_MAX_USES", "5")),
            wake_words=env("RECAPPER_WAKE_WORDS", cls.wake_words),
            auto_answer=env("RECAPPER_AUTO_ANSWER", cls.auto_answer),
            max_answers=int(env("RECAPPER_MAX_ANSWERS", "30")),
            db_path=Path(env("RECAPPER_DB", "recapper.db")),
            knowledge_dir=Path(kb) if kb else None,
            store_segments=_bool("RECAPPER_STORE_SEGMENTS", True),
            retention_days=int(env("RECAPPER_RETENTION_DAYS", "0")),
            asr_provider=env("RECAPPER_ASR", "none"),
            whisper_model=env("RECAPPER_WHISPER_MODEL", cls.whisper_model),
            telegram_token=env("TELEGRAM_BOT_TOKEN", ""),
            telegram_allowed_users={int(x) for x in allowed.split(",") if x.strip()},
            telegram_public=_bool("RECAPPER_TELEGRAM_PUBLIC", False),
        )
