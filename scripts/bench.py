"""Замер скорости нейросети для «Знания в коробке».

Запуск:
    python scripts/bench.py                       # все установленные модели, видеокарта
    python scripts/bench.py --weak                # имитация слабого устройства: только процессор, 4 потока
    python scripts/bench.py --models qwen2.5:3b --runs 3 --out bench.csv

Что меряем для каждого запроса (данные берёт сама Ollama):
    load   — загрузка модели в память (только первый запрос после выгрузки)
    ttft   — сколько ученик ждёт до первого слова (разбор подсказки + загрузка)
    tok/s  — скорость печати ответа
    total  — полное время ответа
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from server import GENERAL, LIB, tutor_messages  # noqa: E402

# 127.0.0.1, а не localhost: в Windows localhost сначала пробует IPv6 и теряет ~2 с на каждом запросе.
OLLAMA = os.environ.get("ZNANIE_LLM_URL", "http://127.0.0.1:11434").rstrip("/")
QUESTIONS = [
    ("библиотека", "Почему высохло Аральское море?"),
    ("библиотека", "Что такое закон Ома?"),
    ("библиотека", "Как найти дискриминант?"),
    ("вне библиотеки", "Почему небо голубое?"),
]


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(OLLAMA + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())


def messages(kind: str, q: str) -> list[dict]:
    if kind == "библиотека":
        return tutor_messages({"message": q, "mode": "socratic", "level": 0}, LIB.search(q)[:3])
    return [{"role": "system", "content": GENERAL.format(grade=8)}, {"role": "user", "content": q}]


def run(model: str, msgs: list[dict], options: dict) -> dict:
    t0 = time.perf_counter()
    first = None
    text = []
    stats = {}
    req = urllib.request.Request(OLLAMA + "/api/chat", json.dumps({
        "model": model, "messages": msgs, "stream": True, "think": False, "options": options,
    }).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        for line in r:
            chunk = json.loads(line)
            piece = chunk.get("message", {}).get("content", "")
            if piece and first is None:
                first = time.perf_counter() - t0
            text.append(piece)
            if chunk.get("done"):
                stats = chunk
    ns = 1e9
    return {
        "load": stats.get("load_duration", 0) / ns,
        "prompt_tokens": stats.get("prompt_eval_count", 0),
        "prompt_s": stats.get("prompt_eval_duration", 0) / ns,
        "ttft": first or 0,
        "tokens": stats.get("eval_count", 0),
        "tok_s": stats.get("eval_count", 0) / max(stats.get("eval_duration", 1) / ns, 1e-9),
        "total": time.perf_counter() - t0,
        "answer": "".join(text).strip().replace("\n", " ")[:120],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*")
    ap.add_argument("--weak", action="store_true", help="только процессор, 4 потока (как Raspberry Pi 5 / старый ноутбук)")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--ctx", type=int, default=2048)
    ap.add_argument("--out")
    a = ap.parse_args()

    models = a.models or [m["name"] for m in json.loads(urllib.request.urlopen(OLLAMA + "/api/tags").read())["models"]]
    options = {"num_ctx": a.ctx, "temperature": 0.3}
    if a.weak:
        options |= {"num_gpu": 0, "num_thread": a.threads}
    print(f"Режим: {'слабое устройство (CPU, ' + str(a.threads) + ' потока)' if a.weak else 'как есть (видеокарта, если есть)'}; num_ctx={a.ctx}\n")

    rows = []
    for model in models:
        post("/api/generate", {"model": model, "keep_alive": 0})  # выгрузить — честный холодный старт
        cold = run(model, messages(*QUESTIONS[0]), options)
        print(f"{model}: холодный старт {cold['total']:.1f} с (загрузка {cold['load']:.1f} с)")
        for kind, q in QUESTIONS:
            for i in range(a.runs):
                r = run(model, messages(kind, q), options)
                rows.append({"model": model, "weak": a.weak, "kind": kind, "question": q, "run": i, **r})
                print(f"  {kind:15} ждать {r['ttft']:5.1f} с · {r['tok_s']:5.1f} ток/с · всего {r['total']:5.1f} с · {r['prompt_tokens']} ток. подсказки · «{r['answer'][:60]}…»")
        by = [r for r in rows if r["model"] == model]
        print(f"  ИТОГ {model}: медиана ожидания {statistics.median(r['ttft'] for r in by):.1f} с, "
              f"медиана ответа {statistics.median(r['total'] for r in by):.1f} с, {statistics.median(r['tok_s'] for r in by):.0f} ток/с\n")
    if a.out:
        with open(a.out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print("Сохранено:", a.out)


if __name__ == "__main__":
    main()
