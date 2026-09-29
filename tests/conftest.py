from __future__ import annotations

from pathlib import Path

import pytest

from recapper.config import Settings
from recapper.knowledge import KnowledgeBase

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"


@pytest.fixture(autouse=True)
def _no_real_credentials(monkeypatch):
    # Tests must never hit the real API, whatever the developer's shell has.
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "RECAPPER_API_TOKEN", "TELEGRAM_BOT_TOKEN",
                "RECAPPER_ASR", "RECAPPER_KNOWLEDGE_DIR"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(db_path=tmp_path / "test.db")


@pytest.fixture
def kb() -> KnowledgeBase:
    return KnowledgeBase.from_dir(EXAMPLES / "knowledge")


@pytest.fixture
def meeting_text() -> str:
    return (EXAMPLES / "meeting_samokat_kuper.txt").read_text("utf-8")
