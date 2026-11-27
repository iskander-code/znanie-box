"""Кэш ответов Совы на частые вопросы (SQLite, только стандартная библиотека).

Если ученики класса задают одинаковый вопрос по одной теме, второй и следующие получают
готовый ответ мгновенно, без нейросети. Ключ — хэш всего запроса к модели (подсказка,
режим, уровень, класс, фрагменты библиотеки, история) и названия модели, поэтому
другая нейросеть, другой режим или другая история диалога дают другой ключ.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

TTL = 7 * 24 * 3600  # ответ хранится неделю: учебник за неделю не меняется
MAX_ROWS = 5000


class AnswerCache:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, answer TEXT NOT NULL, created REAL NOT NULL, hits INTEGER NOT NULL DEFAULT 0)")

    @contextmanager
    def _db(self):
        """Соединение на одну операцию: сохраняет изменения и всегда закрывается (на Windows файл не остаётся занят)."""
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def key(model: str | None, messages: list[dict], max_tokens: int | None) -> str:
        raw = json.dumps([model, max_tokens, messages], ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def get(self, key: str) -> str | None:
        with self.lock, self._db() as db:
            row = db.execute("SELECT answer, created FROM answers WHERE key = ?", (key,)).fetchone()
            if not row:
                return None
            if time.time() - row[1] > TTL:
                db.execute("DELETE FROM answers WHERE key = ?", (key,))
                return None
            db.execute("UPDATE answers SET hits = hits + 1 WHERE key = ?", (key,))
            return row[0]

    def put(self, key: str, answer: str):
        with self.lock, self._db() as db:
            db.execute("INSERT OR REPLACE INTO answers (key, answer, created, hits) VALUES (?, ?, ?, 0)", (key, answer, time.time()))
            count = db.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
            if count > MAX_ROWS:  # выбрасываем самые старые
                db.execute("DELETE FROM answers WHERE key IN (SELECT key FROM answers ORDER BY created LIMIT ?)", (count - MAX_ROWS,))

    def clear(self) -> int:
        with self.lock, self._db() as db:
            n = db.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
            db.execute("DELETE FROM answers")
            return n

    def stats(self) -> dict:
        with self.lock, self._db() as db:
            n, hits = db.execute("SELECT COUNT(*), COALESCE(SUM(hits), 0) FROM answers").fetchone()
            return {"answers": n, "hits": hits}
