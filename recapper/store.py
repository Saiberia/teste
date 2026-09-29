"""SQLite persistence of finished reports."""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import MeetingReport


class ReportStore:
    def __init__(self, path: Path | str, keep_segments: bool = True):
        self.path = str(path)
        self.keep_segments = keep_segments
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS reports (
                   id TEXT PRIMARY KEY,
                   owner TEXT NOT NULL DEFAULT '',
                   title TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   body TEXT NOT NULL)"""
        )
        self._conn.commit()

    def save(self, report: MeetingReport, owner: str = "") -> None:
        stored = report if self.keep_segments else report.model_copy(update={"segments": []})
        with self._lock:
            self._conn.execute(
                "INSERT INTO reports (id, owner, title, created_at, body) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body",
                (report.id, owner, report.title, datetime.now(timezone.utc).isoformat(), stored.model_dump_json()),
            )
            self._conn.commit()

    def get(self, report_id: str, owner: str | None = None) -> MeetingReport | None:
        query, args = "SELECT body FROM reports WHERE id = ?", [report_id]
        if owner is not None:
            query += " AND owner = ?"
            args.append(owner)
        with self._lock:
            row = self._conn.execute(query, args).fetchone()
        return MeetingReport.model_validate_json(row[0]) if row else None

    def latest(self, owner: str) -> MeetingReport | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT body FROM reports WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", (owner,)
            ).fetchone()
        return MeetingReport.model_validate_json(row[0]) if row else None

    def list(self, owner: str | None = None, limit: int = 50) -> list[dict]:
        query, args = "SELECT id, title, created_at FROM reports", []
        if owner is not None:
            query += " WHERE owner = ?"
            args.append(owner)
        query += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._conn.execute(query, args).fetchall()
        return [{"id": r[0], "title": r[1], "created_at": r[2]} for r in rows]

    def delete(self, report_id: str, owner: str | None = None) -> bool:
        query, args = "DELETE FROM reports WHERE id = ?", [report_id]
        if owner is not None:
            query += " AND owner = ?"
            args.append(owner)
        with self._lock:
            cur = self._conn.execute(query, args)
            self._conn.commit()
        return cur.rowcount > 0

    def all(self, owner: str, limit: int = 200) -> list[MeetingReport]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT body FROM reports WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", (owner, limit)
            ).fetchall()
        return [MeetingReport.model_validate_json(r[0]) for r in rows]

    def purge_older_than(self, days: int) -> int:
        """Retention: drop reports older than ``days`` (0 disables)."""
        if days <= 0:
            return 0
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._lock:
            cur = self._conn.execute("DELETE FROM reports WHERE created_at < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    def close(self) -> None:
        self._conn.close()
