"""«Знание в коробке» — школьный сервер без интернета.

Раздаёт веб-приложение из папки web/ и API для наставника и схем.
Только стандартная библиотека Python 3.10+.

Запуск:
    python server/server.py            # http://localhost:8000, только этот компьютер
    python server/server.py --box      # доступ с других устройств школы (0.0.0.0)
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import socket
import sys
import threading
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm  # noqa: E402
import tts  # noqa: E402
from graphs import extract  # noqa: E402
from rag import Library, is_relevant  # noqa: E402
from teacher import Teacher, hash_pin  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
USER_GRAPHS = ROOT / "data" / "user_graphs"
LIB = Library(WEB / "data" / "library")
TEACHER = Teacher(ROOT / "data" / "state.json")
MAX_BODY = 200_000
EXAM_GENERAL = "Сейчас идёт контрольная: Сова помогает только подсказками по темам школьной библиотеки. Попробуй спросить про тему из учебника."


def lan_addresses() -> list[str]:
    """Адреса этого компьютера в локальной сети — для QR-кода на странице «Как подключить»."""
    found = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # пакеты не отправляются, просто выбирается сетевая карта
            found.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        found.update(a for a in socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    return sorted(a for a in found if not a.startswith(("127.", "169.254.")))

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
# ИИ-помощник учителя: отвечает на любые вопросы из собственных знаний нейросети, а не из библиотеки сайта.
TEACHER_AI = (
    "Ты — ИИ-помощник учителя сельской школы в Казахстане. Отвечай по-русски, по делу и структурно: "
    "списки, шаги, примеры. Отвечай на любые вопросы учителя из своих знаний: план урока, задачи и ответы к ним, "
    "объяснение темы для нужного класса, идеи опытов и игр, проверочные вопросы, письма родителям, работа с классом. "
    "Если не уверен в фактах, датах или числах — так и скажи и посоветуй сверить с учебником или официальной программой. "
    "Не помогай с опасным, незаконным или вредным для детей содержанием."
)

# Предел длины ответа в токенах: подсказка короткая, объяснение длиннее. Обычные ответы короче предела,
# он лишь не даёт модели «заговориться» — на слабом устройстве это десятки секунд.
MAX_TOKENS = {"hint": 160, "answer": 350, "general": 350, "debrief": 400, "teacher": 1500}
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

    # Сжатие: 30 телефонов делят одну раздачу ноутбука, а текст и опыты PhET сжимаются в 3–5 раз.
    GZIP_TYPES = (".html", ".js", ".json", ".css", ".svg", ".webmanifest")
    _gz_cache: dict = {}
    _gz_lock = threading.Lock()

    def _send_gzip(self) -> bool:
        """Отдаёт статический файл сжатым, если браузер это умеет. False — пусть отдаст обычный обработчик."""
        if "gzip" not in self.headers.get("Accept-Encoding", ""):
            return False
        fs_path = self.translate_path(self.path)
        if os.path.isdir(fs_path):
            fs_path = os.path.join(fs_path, "index.html")
        if not fs_path.endswith(self.GZIP_TYPES) or not os.path.isfile(fs_path):
            return False
        st = os.stat(fs_path)
        key = (fs_path, st.st_mtime_ns, st.st_size)
        with self._gz_lock:
            data = self._gz_cache.get(key)
        if data is None:
            with open(fs_path, "rb") as f:
                data = gzip.compress(f.read(), compresslevel=6, mtime=0)
            with self._gz_lock:
                # Старые версии файла (после обновления с флешки) из кэша выбрасываем.
                for k in [k for k in self._gz_cache if k[0] == fs_path]:
                    del self._gz_cache[k]
                self._gz_cache[key] = data
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(fs_path))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        return True

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

    def _teacher(self) -> bool:
        return TEACHER.check(self.headers.get("X-Teacher-Token"))

    def _denied(self):
        return self._json({"error": "Нужен вход учителя по PIN-коду"}, HTTPStatus.FORBIDDEN)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("Слишком большой запрос")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/") and self._send_gzip():
            return
        if path == "/api/health":
            host, port = self.server.server_address[:2]
            box = host == "0.0.0.0"
            lan = [f"http://{a}:{port}/" for a in lan_addresses()] if box else []
            return self._json({"ok": True, **llm.status(), "tts": tts.available(), "exam": TEACHER.exam, "box": box, "lan": lan})
        if path == "/api/settings":
            return self._json(self._settings())
        if path == "/api/teacher/summary":
            if not self._teacher():
                return self._denied()
            return self._json({"topics": TEACHER.summary()})
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
            if path == "/api/teacher/login":
                token, msg = TEACHER.login(str(body.get("pin", "")))
                return self._json({"token": token} if token else {"error": msg}, HTTPStatus.OK if token else HTTPStatus.FORBIDDEN)
            if path == "/api/teacher/logout":
                TEACHER.logout(self.headers.get("X-Teacher-Token"))
                return self._json({"ok": True})
            if path == "/api/settings":
                if not self._teacher():
                    return self._denied()
                if "exam" in body:
                    TEACHER.set_exam(bool(body.get("exam")))
                if "provider" in body:
                    try:
                        TEACHER.set("provider", llm.set_provider(str(body["provider"])))
                    except ValueError as e:
                        return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
                return self._json(self._settings())
            if path == "/api/teacher/keys":
                # Ключ онлайн-нейросети из кабинета учителя: сохранить (key) или удалить (пустой key).
                if not self._teacher():
                    return self._denied()
                pid = str(body.get("provider", ""))
                try:
                    llm.online.set_key(pid, str(body.get("key", "")))
                except ValueError as e:
                    return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
                if not body.get("key") and llm.provider() == "local" and TEACHER.state.get("provider") == pid:
                    TEACHER.set("provider", "local")
                return self._json(self._settings())
            if path == "/api/teacher/test-key":
                if not self._teacher():
                    return self._denied()
                pid = str(body.get("provider", ""))
                try:
                    return self._json({"ok": True, "reply": llm.online.test(pid)})
                except llm.online.Refused:
                    return self._json({"ok": True, "reply": "ключ работает (модель отказалась от пробного вопроса)"})
                except Exception as e:  # noqa: BLE001 — показываем учителю причину простыми словами
                    return self._json({"ok": False, "error": llm.online.describe(e)})
            if path == "/api/teacher/ask":
                if not self._teacher():
                    return self._denied()
                return self._teacher_ask(body)
            if path == "/api/teacher/reset-stats":
                if not self._teacher():
                    return self._denied()
                TEACHER.reset_stats()
                return self._json({"ok": True})
            if path == "/api/report":
                fr = LIB.search(str(body.get("question", "")))
                if is_relevant(fr):
                    TEACHER.record(fr[0]["docId"], fr[0]["title"], "report")
                return self._json({"ok": True})
            if path == "/api/tts":
                if not tts.available():
                    return self._json({"error": "Piper не установлен"}, HTTPStatus.NOT_IMPLEMENTED)
                audio = tts.synthesize(str(body.get("text", "")))
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
                return None
            if path == "/api/extract":
                if not self._teacher():
                    return self._denied()
                text = str(body.get("text", "")).strip()
                if len(text) < 80:
                    return self._json({"error": "Вставьте текст параграфа хотя бы из нескольких предложений"}, HTTPStatus.BAD_REQUEST)
                if not llm.model():
                    return self._json({"error": "Нейросеть не запущена. Запустите Ollama или задайте OLLAMA_API_KEY."}, HTTPStatus.SERVICE_UNAVAILABLE)
                graph, notes = extract(text[:6000])
                return self._json({"graph": graph, "notes": notes})
            if path == "/api/graphs":
                if not self._teacher():
                    return self._denied()
                return self._save_graph(body)
            return self._json({"error": "Нет такого адреса"}, HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        except Exception as e:  # ошибка модели не должна ронять сервер
            return self._json({"error": f"Ошибка: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _teacher_ask(self, body: dict):
        """ИИ-помощник учителя: любой вопрос, ответ из знаний нейросети (Qwen или онлайн по выбору учителя)."""
        question = str(body.get("message", "")).strip()[:4000]
        if not question:
            return self._json({"error": "Пустой вопрос"}, HTTPStatus.BAD_REQUEST)
        if not llm.available():
            return self._json({"answer": None, "llm": False, "error": "Нейросеть не запущена: запустите Ollama или задайте ключ онлайн-нейросети."})
        history = [{"role": m["role"], "content": str(m.get("content", ""))[:4000]}
                   for m in body.get("history", [])[-8:] if m.get("role") in ("user", "assistant")]
        msgs = [{"role": "system", "content": TEACHER_AI}, *history, {"role": "user", "content": question}]
        meta = {"llm": True, "model": llm.label()}
        return self._answer(meta, msgs, MAX_TOKENS["teacher"], False, bool(body.get("stream")))

    def _settings(self) -> dict:
        return {"exam": TEACHER.exam, "provider": llm.provider(), "providers": llm.online.available(),
                "online": llm.online.status(), "model": llm.label(), "llm": llm.available(), "localModel": llm.model()}

    def _chat(self, body: dict):
        mode = body.get("mode", "socratic")
        if mode == "debrief":
            if not llm.available():
                return self._json({"answer": None, "llm": False})
            msgs = [{"role": "system", "content": DEBRIEF}, {"role": "user", "content": json.dumps(body.get("context", {}), ensure_ascii=False)[:8000]}]
            return self._json({"answer": llm.ask(msgs, max_tokens=MAX_TOKENS["debrief"]), "llm": True})
        fragments = LIB.search(str(body.get("message", "")))
        relevant = is_relevant(fragments)
        for f in fragments:
            f["relevant"] = relevant
        level = int(body.get("level", 0))
        if relevant:
            wants_answer = mode in ("explain", "simpler") or level >= 2
            TEACHER.record(fragments[0]["docId"], fragments[0]["title"], "answer" if wants_answer else "hint" if level else "question")
        exam = TEACHER.exam
        if exam:
            # Контрольная: никаких готовых ответов, только подсказки — проверяется здесь, а не в браузере.
            body = {**body, "mode": "socratic", "level": min(level, 1)}
            mode = "socratic"
            if not relevant:
                return self._json({"fragments": [], "answer": EXAM_GENERAL, "exam": True, "llm": llm.available(), "model": "контрольная"})
        if not llm.available():
            return self._json({"fragments": fragments, "answer": None, "llm": False, "exam": exam, "level": body.get("level", 0)})
        stream = bool(body.get("stream"))
        if not relevant:
            # В библиотеке ничего нет — нейросеть отвечает из своих знаний, интерфейс помечает это.
            history = [m for m in body.get("history", [])[-6:] if m.get("role") in ("user", "assistant")]
            msgs = [{"role": "system", "content": GENERAL.format(grade=body.get("grade", 8))}, *history,
                    {"role": "user", "content": str(body.get("message", ""))[:1000]}]
            meta = {"fragments": [], "general": True, "llm": True, "model": llm.label(), "exam": exam}
            return self._answer(meta, msgs, MAX_TOKENS["general"], False, stream)
        hint = mode == "socratic" and int(body.get("level", 0)) < 2
        meta = {"fragments": fragments, "llm": True, "model": llm.label(), "exam": exam, "level": body.get("level", 0)}
        return self._answer(meta, tutor_messages(body, fragments[:3]), MAX_TOKENS["hint" if hint else "answer"], hint, stream)

    def _answer(self, meta: dict, msgs: list[dict], max_tokens: int, must_ask: bool, stream: bool):
        """Ответ нейросети целиком (JSON) или по мере печати (NDJSON: meta → delta… → done).

        must_ask: нужна подсказка-вопрос. Если модель выдала ответ без вопроса, answer = None —
        интерфейс покажет проверенную подсказку-шаблон.
        """
        def final(text: str) -> str | None:
            answer = clean_answer(text)
            return None if must_ask and "?" not in answer else answer

        if not stream:
            try:
                return self._json({**meta, "answer": final(llm.ask(msgs, max_tokens=max_tokens))})
            except llm.OnlineUnavailable as e:
                return self._json({**meta, "answer": None, "note": str(e)})
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        def send(obj: dict):
            self.wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
            self.wfile.flush()

        parts = []
        try:
            send({"type": "meta", **meta})
            for piece in llm.ask_stream(msgs, max_tokens=max_tokens):
                parts.append(piece)
                send({"type": "delta", "text": piece})
            send({"type": "done", "answer": final("".join(parts))})
        except llm.OnlineUnavailable as e:
            # Ни онлайн, ни локальной модели: интерфейс покажет подсказку-шаблон по библиотеке с пометкой.
            send({"type": "done", "answer": None, "note": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass  # ученик закрыл страницу — генерация останавливается вместе с соединением
        except Exception as e:  # noqa: BLE001 — ошибку нейросети показываем ученику понятным текстом
            try:
                send({"type": "error", "error": str(e)})
            except OSError:
                pass

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
    ap.add_argument("--box", action="store_true", help="открыть доступ для других устройств локальной сети")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--pin", help="PIN учителя для этого запуска (по умолчанию 2026, см. server/teacher.py)")
    args = ap.parse_args()
    if args.pin:
        TEACHER.pin_hash = hash_pin(args.pin)
    host = "0.0.0.0" if args.box else "127.0.0.1"
    server = ThreadingHTTPServer((host, args.port), partial(Handler, directory=str(WEB)))
    try:
        llm.set_provider(TEACHER.state.get("provider", "local"))  # выбор учителя сохраняется между запусками
    except ValueError:
        pass  # ключ убрали — отвечает локальная модель
    st = llm.status()
    print(f"Знание в коробке: http://localhost:{args.port}")
    if args.box:
        for a in lan_addresses():
            print(f"  с телефонов и планшетов класса: http://{a}:{args.port}")
    local = st["localModel"]
    print(f"Нейросеть без интернета: {'модель ' + local if local else 'не найдена (Сова отвечает подсказками-шаблонами)'} ({st['mode']})")
    if st["providers"]:
        names = ", ".join(f"{p['name']} {p['model']}" for p in st["providers"])
        print(f"Онлайн-нейросети по ключу: {names}. Сейчас отвечает: {st['model']}. Переключить — в кабинете учителя.")
    if local and st["mode"] == "local":
        # Прогрев: первая загрузка модели в память может занять минуту-две; заодно выбираем модель под железо.
        threading.Thread(target=llm.warm_up, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
