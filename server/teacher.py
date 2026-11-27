"""Режим учителя: вход по PIN, режим контрольной и обезличенная статистика тем.

PIN хранится только в виде хэша (PBKDF2-SHA256). По умолчанию PIN — 2026.
Сменить PIN:
    python server/teacher.py 4815        # напечатает хэш нового PIN
    затем вставьте хэш в PIN_HASH ниже или задайте переменную окружения ZNANIE_TEACHER_PIN_HASH,
    либо запустите сервер с ключом --pin 4815 (хэш посчитается при запуске).

Статистика обезличена: хранится только «по какой теме сколько раз спрашивали,
сколько подсказок и готовых ответов понадобилось» — без имён, устройств и текста вопросов.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path

SALT = b"znanie-box"
ITERATIONS = 120_000
# Хэш PIN «2026». Тот же хэш стоит в web/js/teacher.js для сайта без коробки.
PIN_HASH = os.environ.get("ZNANIE_TEACHER_PIN_HASH", "981f1832f924aabe45970ea6684e8330a97bf28728f0213da47ce17b6daf23c5")
TOKEN_TTL = 8 * 3600  # вход учителя действует один учебный день
MAX_TRIES = 5  # после 5 неверных PIN подряд вход блокируется на минуту
LOCK_SECONDS = 60


def hash_pin(pin: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.strip().encode("utf-8"), SALT, ITERATIONS).hex()


class Teacher:
    def __init__(self, state_file: Path, pin_hash: str = PIN_HASH):
        self.file = state_file
        self.pin_hash = pin_hash
        self.lock = threading.Lock()
        self.tokens: dict[str, float] = {}
        self.fails = 0
        self.locked_until = 0.0
        try:
            self.state = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.state = {}
        self.state.setdefault("exam", False)
        self.state.setdefault("stats", {})
        self.state.setdefault("sims", {})
        # PIN, сменённый в кабинете учителя, хранится хэшем в state.json и важнее PIN по умолчанию.
        if self.state.get("pin_hash") and not os.environ.get("ZNANIE_TEACHER_PIN_HASH") and pin_hash == PIN_HASH:
            self.pin_hash = self.state["pin_hash"]

    def _save(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.file)

    # --- вход ---
    def login(self, pin: str) -> tuple[str | None, str]:
        """Возвращает (токен, сообщение). Токен None — вход не удался."""
        with self.lock:
            now = time.time()
            if now < self.locked_until:
                return None, f"Слишком много попыток. Подождите {int(self.locked_until - now) + 1} с."
            if hmac.compare_digest(hash_pin(str(pin)), self.pin_hash):
                self.fails = 0
                token = secrets.token_urlsafe(24)
                self.tokens = {t: exp for t, exp in self.tokens.items() if exp > now}
                self.tokens[token] = now + TOKEN_TTL
                return token, "ok"
            self.fails += 1
            if self.fails >= MAX_TRIES:
                self.fails = 0
                self.locked_until = now + LOCK_SECONDS
                return None, f"Неверный PIN. Вход заблокирован на {LOCK_SECONDS} с."
            return None, f"Неверный PIN. Осталось попыток: {MAX_TRIES - self.fails}."

    def change_pin(self, old: str, new: str) -> tuple[bool, str]:
        """Смена PIN из кабинета учителя: нужен старый PIN, новый — 4–8 цифр."""
        new = str(new).strip()
        if not new.isdigit() or not 4 <= len(new) <= 8:
            return False, "Новый PIN — это 4–8 цифр"
        with self.lock:
            if not hmac.compare_digest(hash_pin(str(old)), self.pin_hash):
                return False, "Старый PIN неверный"
            self.pin_hash = hash_pin(new)
            self.state["pin_hash"] = self.pin_hash
            self._save()
        return True, "PIN изменён"

    def check(self, token: str | None) -> bool:
        if not token:
            return False
        with self.lock:
            exp = self.tokens.get(token)
            return bool(exp and exp > time.time())

    def logout(self, token: str | None):
        with self.lock:
            self.tokens.pop(token or "", None)

    # --- режим контрольной ---
    @property
    def exam(self) -> bool:
        return bool(self.state["exam"])

    def set(self, key: str, value):
        """Сохранить настройку коробки (например, выбранную нейросеть)."""
        with self.lock:
            self.state[key] = value
            self._save()

    def set_exam(self, on: bool):
        with self.lock:
            self.state["exam"] = bool(on)
            self._save()

    # --- обезличенная статистика ---
    def record(self, doc_id: str, title: str, kind: str):
        """kind: question | hint | answer | report"""
        if not doc_id:
            return
        with self.lock:
            s = self.state["stats"].setdefault(doc_id, {"title": title, "question": 0, "hint": 0, "answer": 0, "report": 0})
            s[kind] = s.get(kind, 0) + 1
            self._save()

    def record_sim(self, graph_id: str, title: str, total: int, wrong: list[str]):
        """Прогноз ученика в «Что будет, если…»: сколько факторов угадал. Без имён — только по схеме."""
        if not graph_id or total <= 0:
            return
        with self.lock:
            s = self.state["sims"].setdefault(graph_id, {"title": title, "runs": 0, "predictions": 0, "wrong": 0, "factors": {}})
            s["runs"] += 1
            s["predictions"] += int(total)
            s["wrong"] += len(wrong)
            for f in wrong[:20]:
                key = str(f)[:60]
                s["factors"][key] = s["factors"].get(key, 0) + 1
            self._save()

    def sims_summary(self, limit: int = 10) -> list[dict]:
        """Схемы, где ученики чаще ошибаются в прогнозе, и самые «коварные» факторы."""
        with self.lock:
            rows = [{"graphId": k, **v} for k, v in self.state["sims"].items()]
        for r in rows:
            r["errorRate"] = round(r["wrong"] / r["predictions"], 2) if r["predictions"] else 0
            r["hardest"] = [f for f, _ in sorted(r.pop("factors").items(), key=lambda x: -x[1])[:3]]
        return sorted(rows, key=lambda r: (-r["errorRate"], -r["runs"]))[:limit]

    def summary(self, limit: int = 10) -> list[dict]:
        with self.lock:
            rows = [{"docId": k, **v} for k, v in self.state["stats"].items()]
        for r in rows:
            # Тема тем сложнее, чем чаще ученикам нужны подсказки и готовые ответы.
            r["score"] = r["question"] + r["hint"] + 2 * r["answer"] + 3 * r["report"]
        return sorted(rows, key=lambda r: -r["score"])[:limit]

    def reset_stats(self):
        with self.lock:
            self.state["stats"] = {}
            self.state["sims"] = {}
            self._save()


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or not 4 <= len(sys.argv[1]) <= 8:
        sys.exit("Использование: python server/teacher.py <новый PIN из 4–8 цифр>")
    print(hash_pin(sys.argv[1]))
