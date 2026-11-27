"""Запуск: python -m unittest discover tests"""
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import tempfile  # noqa: E402

from graphs import evidence_found, validate  # noqa: E402
from rag import Library, is_relevant, stem  # noqa: E402
from teacher import PIN_HASH, Teacher, hash_pin  # noqa: E402

LIBRARY = ROOT / "web" / "data" / "library"


class RagTest(unittest.TestCase):
    def setUp(self):
        self.lib = Library(LIBRARY)

    def test_stem(self):
        self.assertEqual(stem("Температура"), "темпер")
        self.assertEqual(stem("ёлка"), "елка")

    def test_search_finds_relevant(self):
        fr = self.lib.search("что такое закон Ома")
        self.assertTrue(is_relevant(fr))
        self.assertEqual(fr[0]["title"], "Закон Ома для участка цепи")
        self.assertEqual(len(self.lib.docs), 400)

    def test_offtopic_is_not_relevant(self):
        for q in ("рецепт борща со сметаной", "Почему небо голубое?", "Сколько будет 2+2?"):
            self.assertFalse(is_relevant(self.lib.search(q)), q)
        self.assertTrue(is_relevant(self.lib.search("Почему высохло Аральское море?")))


class GraphValidationTest(unittest.TestCase):
    TEXT = "Чем теплее вода, тем меньше кислорода в ней растворяется. Рыбам становится труднее дышать."

    def test_evidence_fuzzy(self):
        self.assertTrue(evidence_found("чем теплее вода тем меньше кислорода", self.TEXT))
        self.assertFalse(evidence_found("рыбы любят тёплую воду и солнце", self.TEXT))

    def test_validate_drops_unsupported_edges(self):
        raw = {
            "title": "Вода",
            "nodes": [{"id": "t", "label": "Температура воды"}, {"id": "o2", "label": "Кислород"}, {"id": "x", "label": "Солнце"}],
            "edges": [
                {"from": "t", "to": "o2", "sign": -1, "strength": 2, "delay": 0, "evidence": "Чем теплее вода, тем меньше кислорода"},
                {"from": "x", "to": "t", "sign": 1, "strength": 2, "delay": 0, "evidence": "солнце нагревает воду летом"},
                {"from": "t", "to": "zz", "sign": 1, "strength": 2, "delay": 0, "evidence": "Рыбам становится труднее"},
            ],
        }
        g, notes = validate(raw, self.TEXT)
        self.assertEqual([(e["from"], e["to"]) for e in g["edges"]], [("t", "o2")])
        self.assertEqual({n["id"] for n in g["nodes"]}, {"t", "o2"})
        self.assertTrue(g["nodes"][0].get("adjustable"))
        self.assertEqual(len(notes), 3)

    def test_validate_drops_quote_about_other_factors(self):
        text = ("Вырубка лесов уменьшает количество деревьев, которые поглощают углекислый газ. "
                "Поэтому в атмосфере накапливается больше углекислого газа. Из-за эрозии почвы снижаются урожаи.")
        raw = {
            "title": "Лес",
            "nodes": [{"id": "trees", "label": "Количество деревьев"}, {"id": "co2", "label": "Углекислый газ"},
                      {"id": "erosion", "label": "Эрозия почвы"}, {"id": "crop", "label": "Урожайность"}],
            "edges": [
                {"from": "trees", "to": "co2", "sign": -1, "strength": 2, "delay": 0, "evidence": "уменьшает количество деревьев, которые поглощают углекислый газ"},
                {"from": "co2", "to": "erosion", "sign": 1, "strength": 2, "delay": 0, "evidence": "в атмосфере накапливается больше углекислого газа"},
                {"from": "erosion", "to": "crop", "sign": -1, "strength": 2, "delay": 1, "evidence": "Из-за эрозии почвы снижаются урожаи"},
            ],
        }
        g, notes = validate(raw, text)
        self.assertEqual([(e["from"], e["to"]) for e in g["edges"]], [("trees", "co2"), ("erosion", "crop")])
        self.assertIn("обоих факторах", notes[0])


class TeacherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Teacher(Path(self.tmp.name) / "state.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_pin_hash_matches_browser(self):
        self.assertEqual(hash_pin("2026"), PIN_HASH)
        self.assertIn(PIN_HASH, (ROOT / "web" / "js" / "teacher.js").read_text(encoding="utf-8"))

    def test_login_and_lockout(self):
        token, _ = self.t.login("2026")
        self.assertTrue(self.t.check(token))
        self.assertFalse(self.t.check("чужой"))
        for _ in range(5):
            self.assertIsNone(self.t.login("0000")[0])
        token2, msg = self.t.login("2026")
        self.assertIsNone(token2, "после 5 ошибок вход заблокирован даже с верным PIN")
        self.assertIn("Подождите", msg)

    def test_stats_are_anonymous_and_ranked(self):
        self.t.record("a", "Тема А", "question")
        for kind in ("question", "hint", "answer", "report"):
            self.t.record("b", "Тема Б", kind)
        rows = self.t.summary()
        self.assertEqual([r["docId"] for r in rows], ["b", "a"])
        self.assertEqual(set(rows[0]), {"docId", "title", "question", "hint", "answer", "report", "score"})
        self.t.set_exam(True)
        self.assertTrue(Teacher(self.t.file).exam, "режим контрольной сохраняется на диск")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server
        cls.server = server
        cls.tmp = tempfile.TemporaryDirectory()
        server.TEACHER = Teacher(Path(cls.tmp.name) / "state.json")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=str(server.WEB)))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=10) as r:
            return r.headers, r.read()

    def post(self, path, body, token=None):
        headers = {"Content-Type": "application/json", **({"X-Teacher-Token": token} if token else {})}
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())

    def status(self, path, body, token=None):
        try:
            self.post(path, body, token)
            return 200
        except urllib.error.HTTPError as e:
            return e.code

    def test_static_and_mime(self):
        headers, _ = self.get("/js/app.js")
        self.assertIn("javascript", headers["Content-Type"])
        _, html = self.get("/")
        self.assertIn("Знание в коробке".encode(), html)

    def test_health(self):
        _, raw = self.get("/api/health")
        self.assertTrue(json.loads(raw)["ok"])

    def test_chat_returns_fragments(self):
        r = self.post("/api/chat", {"message": "Кто основал Казахское ханство?", "mode": "socratic", "level": 0})
        self.assertTrue(r["fragments"])
        self.assertTrue(r["fragments"][0]["relevant"])

    def stream(self, body):
        req = urllib.request.Request(self.base + "/api/chat", data=json.dumps({**body, "stream": True}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.headers["Content-Type"], [json.loads(line) for line in r if line.strip()]

    def test_chat_streams_answer_by_pieces(self):
        from unittest import mock
        llm = self.server.llm
        calls = []

        def fake_stream(msgs, max_tokens=None):
            calls.append(max_tokens)
            yield from pieces

        with mock.patch.object(llm, "model", return_value="fake"), mock.patch.object(llm, "chat_stream", fake_stream):
            pieces = ["Подумай, ", "почему ", "уровень упал?"]
            ctype, lines = self.stream({"message": "Почему высохло Аральское море?", "mode": "socratic", "level": 0})
            self.assertIn("ndjson", ctype)
            self.assertEqual([x["type"] for x in lines], ["meta", "delta", "delta", "delta", "done"])
            self.assertTrue(lines[0]["fragments"])
            self.assertEqual("".join(x["text"] for x in lines if x["type"] == "delta"), "".join(pieces))
            self.assertEqual(lines[-1]["answer"], "Подумай, почему уровень упал?")
            # Подсказка без вопроса заменяется проверенным шаблоном: answer = None.
            pieces = ["Уровень упал из-за орошения."]
            _, lines = self.stream({"message": "Почему высохло Аральское море?", "mode": "socratic", "level": 0})
            self.assertIsNone(lines[-1]["answer"])
            # Вопрос не по библиотеке — ответ «из знаний нейросети» с пометкой general.
            pieces = ["Из-за рассеяния света."]
            _, lines = self.stream({"message": "Почему небо голубое?", "mode": "socratic", "level": 0})
            self.assertTrue(lines[0]["general"])
            self.assertEqual(lines[-1]["answer"], "Из-за рассеяния света.")
        self.assertEqual(calls, [160, 160, 350], "подсказка короче объяснения")

    def test_teacher_endpoints_need_pin(self):
        self.assertEqual(self.status("/api/settings", {"exam": True}), 403)
        self.assertEqual(self.status("/api/graphs", {"graph": {"nodes": [1], "edges": [1]}}), 403)
        self.assertEqual(self.status("/api/extract", {"text": "x" * 100}), 403)
        self.assertEqual(self.status("/api/teacher/login", {"pin": "1111"}), 403)
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        req = urllib.request.Request(self.base + "/api/teacher/summary", headers={"X-Teacher-Token": token})
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertIn("topics", json.loads(r.read()))
        self.assertEqual(self.status("/api/settings", {"exam": False}, token), 200)

    def test_exam_mode_blocks_ready_answers(self):
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        self.post("/api/settings", {"exam": True}, token)
        try:
            _, raw = self.get("/api/settings")
            self.assertTrue(json.loads(raw)["exam"])
            r = self.post("/api/chat", {"message": "Почему небо голубое?", "mode": "socratic", "level": 0})
            self.assertTrue(r["exam"])
            self.assertIn("контрольная", r["answer"])
            r = self.post("/api/chat", {"message": "Что такое закон Ома?", "mode": "explain", "level": 2})
            self.assertTrue(r["exam"])
            if r.get("answer") is None:
                self.assertEqual(r["level"], 1, "сервер понижает уровень до подсказки")
        finally:
            self.post("/api/settings", {"exam": False}, token)

    def test_switch_to_online_provider_needs_pin_and_key(self):
        from unittest import mock
        import os
        self.assertEqual(self.status("/api/settings", {"provider": "claude"}), 403)
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
            self.assertEqual(self.status("/api/settings", {"provider": "claude"}, token), 400, "без ключа нельзя")
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            try:
                r = self.post("/api/settings", {"provider": "claude"}, token)
                self.assertEqual(r["provider"], "claude")
                self.assertIn("онлайн", r["model"])
                _, raw = self.get("/api/health")
                health = json.loads(raw)
                self.assertEqual(health["provider"], "claude")
                self.assertNotIn("test-key", raw.decode(), "ключ не уходит на страницу")
            finally:
                self.post("/api/settings", {"provider": "local"}, token)


class FakeProviders(BaseHTTPRequestHandler):
    """Имитация Claude, OpenAI и Gemini: отвечает потоком SSE в формате каждого сервиса."""
    requests: list = []
    refuse = False

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeProviders.requests.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if self.path.startswith("/v1/messages"):
            events = [{"type": "message_start"}, {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": ""}}]
            events += [{"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}} for t in ("Привет ", "от Claude")]
            if FakeProviders.refuse:
                events = [{"type": "message_delta", "delta": {"stop_reason": "refusal"}}]
            events.append({"type": "message_stop"})
        elif self.path.startswith("/v1/chat/completions"):
            events = [{"choices": [{"delta": {"content": t}}]} for t in ("Привет ", "от GPT")]
        else:
            events = [{"candidates": [{"content": {"parts": [{"text": "думаю", "thought": True}, {"text": t}]}}]} for t in ("Привет ", "от Gemini")]
        for ev in events:
            self.wfile.write(f"event: x\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())
        if self.path.startswith("/v1/chat"):
            self.wfile.write(b"data: [DONE]\n\n")


class OnlineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import online
        cls.online = online
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeProviders)
        url = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.saved = {pid: p["url"] for pid, p in online.PROVIDERS.items()}
        for p in online.PROVIDERS.values():
            p["url"] = url

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for pid, u in cls.saved.items():
            cls.online.PROVIDERS[pid]["url"] = u

    def setUp(self):
        FakeProviders.requests.clear()
        FakeProviders.refuse = False

    MSGS = [{"role": "system", "content": "Ты — Сова."}, {"role": "user", "content": "Что такое закон Ома?"},
            {"role": "system", "content": "Закончи вопросом."}]

    def keys(self, **extra):
        import os
        from unittest import mock
        return mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "k-a", "OPENAI_API_KEY": "k-o", "GEMINI_API_KEY": "k-g", **extra})

    def test_each_provider_streams_text(self):
        with self.keys():
            self.assertEqual([p["id"] for p in self.online.available()], ["claude", "openai", "gemini"])
            for pid, expected in (("claude", "Привет от Claude"), ("openai", "Привет от GPT"), ("gemini", "Привет от Gemini")):
                self.assertEqual("".join(self.online.stream(pid, self.MSGS)), expected, pid)
        (p1, h1, b1), (p2, h2, b2), (p3, h3, b3) = FakeProviders.requests
        self.assertEqual(h1["x-api-key"], "k-a")
        self.assertEqual(b1["model"], "claude-opus-5-5")
        self.assertEqual(b1["system"], "Ты — Сова.\n\nЗакончи вопросом.", "все указания — в одно системное поле")
        self.assertEqual([m["role"] for m in b1["messages"]], ["user"])
        self.assertEqual(h2["authorization"], "Bearer k-o")
        self.assertEqual(h3["x-goog-api-key"], "k-g")
        self.assertIn(":streamGenerateContent", p3)
        self.assertEqual(b3["systemInstruction"]["parts"][0]["text"], "Ты — Сова.\n\nЗакончи вопросом.")

    def test_model_can_be_changed_by_env(self):
        with self.keys(ZNANIE_CLAUDE_MODEL="claude-haiku-5-5"):
            "".join(self.online.stream("claude", self.MSGS))
        self.assertEqual(FakeProviders.requests[0][2]["model"], "claude-haiku-5-5")

    def test_no_internet_falls_back_to_local_model(self):
        import llm
        from unittest import mock
        with self.keys(), mock.patch.object(llm, "model", return_value="qwen2.5:3b"), \
                mock.patch.object(llm, "chat_stream", lambda msgs, max_tokens=None: iter(["Ответ ", "Qwen"])), \
                mock.patch.dict(self.online.PROVIDERS["openai"], {"url": "http://127.0.0.1:9"}):
            llm.set_provider("openai")
            try:
                text = llm.ask(self.MSGS)
            finally:
                llm.set_provider("local")
        self.assertTrue(text.startswith("Ответ Qwen"))
        self.assertIn("локальная модель", text)

    def test_refusal_is_not_bypassed_by_local_model(self):
        import llm
        from unittest import mock
        FakeProviders.refuse = True
        local = mock.Mock(side_effect=AssertionError("локальная модель не должна отвечать после отказа"))
        with self.keys(), mock.patch.object(llm, "chat_stream", local):
            llm.set_provider("claude")
            try:
                self.assertEqual(llm.ask(self.MSGS), llm.REFUSED_TEXT)
            finally:
                llm.set_provider("local")


if __name__ == "__main__":
    unittest.main()
