"""Runtime settings, read from environment variables."""

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
    # Claude
    model: str = "claude-opus-5-5"
    detect_effort: str = "low"
    answer_effort: str = "high"
    web_search: bool = True
    web_search_max_uses: int = 5
    # Storage / knowledge
    db_path: Path = Path("recapper.db")
    knowledge_dir: Path | None = None
    # ASR
    asr_provider: str = "none"  # none | faster-whisper
    whisper_model: str = "large-v3"
    whisper_language: str = "ru"
    # Privacy
    store_segments: bool = True
    # Telegram
    telegram_token: str = ""
    telegram_allowed_users: set[int] = field(default_factory=set)

    @property
    def has_claude(self) -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))

    @classmethod
    def from_env(cls) -> "Settings":
        kb = os.environ.get("RECAPPER_KNOWLEDGE_DIR")
        allowed = os.environ.get("RECAPPER_TELEGRAM_ALLOWED_USERS", "")
        return cls(
            model=os.environ.get("RECAPPER_MODEL", cls.model),
            detect_effort=os.environ.get("RECAPPER_DETECT_EFFORT", cls.detect_effort),
            answer_effort=os.environ.get("RECAPPER_ANSWER_EFFORT", cls.answer_effort),
            web_search=_bool("RECAPPER_WEB_SEARCH", True),
            web_search_max_uses=int(os.environ.get("RECAPPER_WEB_SEARCH_MAX_USES", "5")),
            db_path=Path(os.environ.get("RECAPPER_DB", "recapper.db")),
            knowledge_dir=Path(kb) if kb else None,
            asr_provider=os.environ.get("RECAPPER_ASR", "none"),
            whisper_model=os.environ.get("RECAPPER_WHISPER_MODEL", cls.whisper_model),
            whisper_language=os.environ.get("RECAPPER_WHISPER_LANGUAGE", cls.whisper_language),
            store_segments=_bool("RECAPPER_STORE_SEGMENTS", True),
            telegram_token=os.environ.get("TELEGRAM_BOT_TOKEN", ""),
            telegram_allowed_users={int(x) for x in allowed.split(",") if x.strip()},
        )
