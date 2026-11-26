"""«Знание в коробке» — школьный сервер без интернета.

Раздаёт веб-приложение из папки web/ и API для наставника и схем.
Только стандартная библиотека Python 3.10+.

Запуск:
    python server/server.py            # http://localhost:8000, только этот компьютер
    python server/server.py --box      # для всего класса по Wi-Fi (0.0.0.0)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm  # noqa: E402
from graphs import extract  # noqa: E402
from rag import Library, is_relevant  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
USER_GRAPHS = ROOT / "data" / "user_graphs"
LIB = Library(WEB / "data" / "library")
MAX_BODY = 200_000

GENERAL = (
    "Ты — Сова, доброжелательный наставник школьника {grade} класса в Казахстане. "
    "В школьной библиотеке нет материала по этому вопросу, поэтому ответь из своих знаний. "
    "Обращайся к ученику на «ты». Отвечай по-русски, понятно для его возраста, не больше 6 предложений. "
    "Если не уверен в фактах, датах или числах — честно скажи об этом и посоветуй проверить в учебнике. "
    "Не помогай с опасным, незаконным или взрослым содержанием: мягко откажи и посоветуй обратиться к учителю или родителям."
)

SYSTEM = (
    "Ты — Сова, доброжелательный наставник школьника {grade} класса в Казахстане. "
    "Обращайся к ученику на «ты». Отвечай по-русски, просто и коротко: не больше 5 предложений. "
    "Опирайся ТОЛЬКО на фрагменты из школьной библиотеки ниже. Если ответа в них нет, честно скажи: "
    "«В библиотеке этого нет, спроси учителя». Не выдумывай факты, даты и числа."
)
MODES = {
    ("socratic", 0): "Не давай готовый ответ. Задай ОДИН наводящий вопрос и процитируй короткую фразу из фрагмента, в которой есть подсказка.",
    ("socratic", 1): "Не давай полный ответ. Назови первый шаг рассуждения и задай вопрос, который подведёт ученика к следующему шагу.",
    ("socratic", 2): "Теперь объясни ответ полностью по фрагментам и предложи ученику пересказать его своими словами.",
    ("explain", 0): "Объясни ответ полностью по фрагментам и предложи ученику пересказать его своими словами.",
    ("simpler", 0): "Объясни как ученику 5 класса, одним коротким примером из сельской жизни (огород, ферма, речка, сельский магазин).",
}
DEBRIEF = (
    "Ты — Сова, наставник школьника. Ученик сделал прогноз и запустил симуляцию причинно-следственной схемы. "
    "Разбери результат по-русски, не больше 7 предложений. Похвали верные догадки. Для каждой ошибки объясни "
    "цепочку связей, опираясь на цитаты из схемы. Напомни, что схема — упрощённая модель. "
    "В конце задай ОДИН вопрос на перенос: где ещё встречается такой механизм."
)


def tutor_messages(body: dict, fragments: list[dict]) -> list[dict]:
    mode = body.get("mode", "socratic")
    level = int(body.get("level", 0)) if mode == "socratic" else 0
    instruction = MODES.get((mode, min(level, 2)), MODES[("socratic", 0)])
    context = "\n".join(f"[{f['title']}] {f['text']}" for f in fragments)
    system = SYSTEM.format(grade=body.get("grade", 8)) + "\n" + instruction + "\n\nФРАГМЕНТЫ:\n" + context
    history = [m for m in body.get("history", [])[-6:] if m.get("role") in ("user", "assistant")]
    msgs = [{"role": "system", "content": system}, *history, {"role": "user", "content": str(body.get("message", ""))[:1000]}]
    if mode == "socratic" and level < 2:
        # Маленькие модели лучше слушаются правила, стоящего последним.
        msgs.append({"role": "system", "content": f"НЕ отвечай на вопрос прямо. {instruction} Начни со слова «Подумай», закончи свой ответ вопросом со знаком «?»."})
    return msgs


def clean_answer(text: str) -> str:
    """Убирает служебный текст, если модель повторила инструкцию в ответе."""
    text = re.sub(r"\(?\s*Правило для Совы:[^)]*\)?", "", text, flags=re.I)
    text = re.sub(r"(?im)^\s*(НЕ отвечай на вопрос прямо\.|Не давай готовый ответ\.)[^\n]*\n?", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    # Отказ в конце содержательного ответа сбивает ученика — убираем его.
    if len(text) > 150:
        text = re.sub(r"\s*В библиотеке этого нет,? спроси учителя\.?\s*$", "", text, flags=re.I)
    return text


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")  # после обновления с флешки ученики сразу видят новое
        super().end_headers()

    def log_message(self, fmt, *args):  # короче стандартного лога
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _json(self, data, status=HTTPStatus.OK):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("Слишком большой запрос")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._json({"ok": True, **llm.status()})
        if path == "/api/graphs":
            USER_GRAPHS.mkdir(parents=True, exist_ok=True)
            graphs = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(USER_GRAPHS.glob("*.json"))]
            return self._json(graphs)
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            body = self._body()
            if path == "/api/search":
                return self._json(LIB.search(str(body.get("query", ""))))
            if path == "/api/chat":
                return self._chat(body)
            if path == "/api/extract":
                text = str(body.get("text", "")).strip()
                if len(text) < 80:
                    return self._json({"error": "Вставьте текст параграфа хотя бы из нескольких предложений"}, HTTPStatus.BAD_REQUEST)
                if not llm.model():
                    return self._json({"error": "Нейросеть не запущена. Запустите Ollama или задайте OLLAMA_API_KEY."}, HTTPStatus.SERVICE_UNAVAILABLE)
                graph, notes = extract(text[:6000])
                return self._json({"graph": graph, "notes": notes})
            if path == "/api/graphs":
                return self._save_graph(body)
            return self._json({"error": "Нет такого адреса"}, HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        except Exception as e:  # ошибка модели не должна ронять сервер
            return self._json({"error": f"Ошибка: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _chat(self, body: dict):
        mode = body.get("mode", "socratic")
        if mode == "debrief":
            if not llm.model():
                return self._json({"answer": None, "llm": False})
            msgs = [{"role": "system", "content": DEBRIEF}, {"role": "user", "content": json.dumps(body.get("context", {}), ensure_ascii=False)[:8000]}]
            return self._json({"answer": llm.chat(msgs), "llm": True})
        fragments = LIB.search(str(body.get("message", "")))
        relevant = is_relevant(fragments)
        for f in fragments:
            f["relevant"] = relevant
        if not llm.model():
            return self._json({"fragments": fragments, "answer": None, "llm": False})
        if not relevant:
            # В библиотеке ничего нет — нейросеть отвечает из своих знаний, интерфейс помечает это.
            history = [m for m in body.get("history", [])[-6:] if m.get("role") in ("user", "assistant")]
            msgs = [{"role": "system", "content": GENERAL.format(grade=body.get("grade", 8))}, *history,
                    {"role": "user", "content": str(body.get("message", ""))[:1000]}]
            answer = clean_answer(llm.chat(msgs))
            return self._json({"fragments": [], "answer": answer, "general": True, "llm": True, "model": llm.model()})
        answer = clean_answer(llm.chat(tutor_messages(body, fragments[:3])))
        if mode == "socratic" and int(body.get("level", 0)) < 2 and "?" not in answer:
            # Модель выдала ответ вместо наводящего вопроса — отдаём проверенную подсказку-шаблон.
            return self._json({"fragments": fragments, "answer": None, "llm": True})
        return self._json({"fragments": fragments, "answer": answer, "llm": True, "model": llm.model()})

    def _save_graph(self, body: dict):
        g = body.get("graph") or {}
        if not g.get("nodes") or not g.get("edges"):
            return self._json({"error": "Пустая схема"}, HTTPStatus.BAD_REQUEST)
        gid = re.sub(r"[^a-z0-9-]", "", str(g.get("id", "user-graph")).lower())[:40] or "user-graph"
        g["id"] = gid
        g["verified_by_teacher"] = True
        USER_GRAPHS.mkdir(parents=True, exist_ok=True)
        (USER_GRAPHS / f"{gid}.json").write_text(json.dumps(g, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._json({"ok": True, "id": gid})


def main():
    ap = argparse.ArgumentParser(description="Знание в коробке — школьный сервер без интернета")
    ap.add_argument("--box", action="store_true", help="открыть доступ для всех устройств в Wi-Fi сети")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    host = "0.0.0.0" if args.box else "127.0.0.1"
    server = ThreadingHTTPServer((host, args.port), partial(Handler, directory=str(WEB)))
    st = llm.status()
    print(f"Знание в коробке: http://localhost:{args.port}")
    print(f"Нейросеть: {'включена, модель ' + st['model'] if st['llm'] else 'не найдена, наставник работает в демо-режиме'} ({st['mode']})")
    if st["llm"] and st["mode"] == "local":
        # Прогрев: первая загрузка модели в память может занять минуту-две.
        threading.Thread(target=lambda: llm.chat([{"role": "user", "content": "Привет"}]), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
