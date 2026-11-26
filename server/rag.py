"""Поиск по библиотеке: SQLite FTS5 (BM25) на основах слов.

Без внешних зависимостей. Основа слова — простое усечение, так же, как в
web/js/tutor-local.js, чтобы сайт и сервер находили одно и то же.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

STOP = set(
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от "
    "меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам "
    "ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего "
    "раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы "
    "нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас "
    "про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им "
    "более всегда конечно всю между почему расскажи объясни скажи такое это".split()
)
WORD = re.compile(r"[а-яa-z0-9]+")
SENT = re.compile(r"[^.!?]+[.!?]+(?:\s|$)")


def stem(word: str) -> str:
    w = word.lower().replace("ё", "е")
    if len(w) > 6:
        return w[:6]
    if len(w) > 4:
        return w[:-1]
    return w


def tokens(text: str) -> list[str]:
    words = WORD.findall(text.lower().replace("ё", "е"))
    return [stem(w) for w in words if len(w) > 2 and w not in STOP]


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in SENT.findall(text)] or [text]


class Library:
    def __init__(self, texts_path: Path):
        self.docs = json.loads(Path(texts_path).read_text(encoding="utf-8"))
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.execute("CREATE VIRTUAL TABLE chunks USING fts5(stems, text UNINDEXED, doc UNINDEXED)")
        rows = []
        for d in self.docs:
            sents = split_sentences(d["text"])
            for i in range(0, len(sents), 2):
                text = " ".join(sents[i : i + 2])
                rows.append((" ".join(tokens(text + " " + d["title"])), text, d["id"]))
        self.db.executemany("INSERT INTO chunks VALUES (?, ?, ?)", rows)
        self.by_id = {d["id"]: d for d in self.docs}

    def search(self, query: str, k: int = 4) -> list[dict]:
        q = list(dict.fromkeys(tokens(query)))
        if not q:
            return []
        match = " OR ".join(f'"{t}"' for t in q)
        rows = self.db.execute(
            "SELECT stems, text, doc, bm25(chunks) AS s FROM chunks WHERE chunks MATCH ? ORDER BY s LIMIT ?",
            (match, k),
        ).fetchall()
        out = []
        for stems, text, doc_id, s in rows:
            doc = self.by_id[doc_id]
            have = set(stems.split())
            out.append({
                "title": doc["title"],
                "docId": doc_id,
                "graph": doc.get("graph"),
                "text": text,
                # bm25() в SQLite отрицательный: чем меньше, тем лучше.
                "score": round(-s * 3, 3),
                "matched": round(sum(t in have for t in q) / len(q), 3),
            })
        return out


def is_relevant(fragments: list[dict]) -> bool:
    return bool(fragments) and fragments[0]["matched"] >= 0.34
