"""Запуск: python -m unittest discover tests"""
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
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


if __name__ == "__main__":
    unittest.main()
