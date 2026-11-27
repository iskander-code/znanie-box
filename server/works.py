"""Работы учеников из «Песочницы»: карта мыслей + заметки, отправленные учителю на проверку (SQLite).

Ученик указывает только имя или ник и тему — без логинов. Учитель (по PIN) видит список,
открывает карту, просит мнение ИИ и оставляет комментарий и оценку.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

MAX_NODES, MAX_EDGES, MAX_NOTES = 60, 120, 6000


def clean_map(raw: dict) -> dict:
    """Карта ученика без лишнего: узлы, связи с подписями, ограничения по размеру."""
    nodes, ids = [], set()
    for n in (raw or {}).get("nodes", [])[:MAX_NODES]:
        nid = str(n.get("id", ""))[:40]
        label = str(n.get("label", "")).strip()[:80]
        if not nid or not label or nid in ids:
            continue
        ids.add(nid)
        nodes.append({"id": nid, "label": label, "desc": str(n.get("desc", ""))[:400]})
    edges = []
    for e in (raw or {}).get("edges", [])[:MAX_EDGES]:
        a, b = str(e.get("from", "")), str(e.get("to", ""))
        if a in ids and b in ids and a != b:
            sign = int(e.get("sign", 1) or 1)
            edges.append({"from": a, "to": b, "sign": 1 if sign >= 0 else -1, "label": str(e.get("label", ""))[:60]})
    return {"nodes": nodes, "edges": edges}


class WorksStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS works (
                id INTEGER PRIMARY KEY AUTOINCREMENT, created REAL NOT NULL, name TEXT NOT NULL, topic TEXT NOT NULL,
                map TEXT NOT NULL, notes TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '', grade TEXT NOT NULL DEFAULT '',
                reviewed REAL)""")

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def add(self, name: str, topic: str, map_: dict, notes: str) -> int:
        name = str(name).strip()[:40]
        topic = str(topic).strip()[:120]
        if not name or not topic:
            raise ValueError("Укажи имя (или ник) и тему исследования")
        m = clean_map(map_)
        if not m["nodes"] and not str(notes).strip():
            raise ValueError("Карта и заметки пустые — добавь хотя бы одну идею")
        with self.lock, self._db() as db:
            cur = db.execute("INSERT INTO works (created, name, topic, map, notes) VALUES (?, ?, ?, ?, ?)",
                             (time.time(), name, topic, json.dumps(m, ensure_ascii=False), str(notes)[:MAX_NOTES]))
            return int(cur.lastrowid)

    def list(self) -> list[dict]:
        with self.lock, self._db() as db:
            rows = db.execute("SELECT id, created, name, topic, map, grade, reviewed FROM works ORDER BY created DESC").fetchall()
        out = []
        for r in rows:
            m = json.loads(r["map"])
            out.append({"id": r["id"], "created": r["created"], "name": r["name"], "topic": r["topic"],
                        "nodes": len(m["nodes"]), "edges": len(m["edges"]), "grade": r["grade"], "reviewed": bool(r["reviewed"])})
        return out

    def get(self, wid: int) -> dict | None:
        with self.lock, self._db() as db:
            r = db.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
        if not r:
            return None
        return {"id": r["id"], "created": r["created"], "name": r["name"], "topic": r["topic"], "map": json.loads(r["map"]),
                "notes": r["notes"], "comment": r["comment"], "grade": r["grade"], "reviewed": bool(r["reviewed"])}

    def review(self, wid: int, comment: str, grade: str) -> bool:
        with self.lock, self._db() as db:
            cur = db.execute("UPDATE works SET comment = ?, grade = ?, reviewed = ? WHERE id = ?",
                             (str(comment)[:2000], str(grade)[:20], time.time(), wid))
            return cur.rowcount > 0

    def delete(self, wid: int) -> bool:
        with self.lock, self._db() as db:
            return db.execute("DELETE FROM works WHERE id = ?", (wid,)).rowcount > 0
