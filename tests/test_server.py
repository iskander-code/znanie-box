"""Запуск: python -m unittest discover tests"""
import json
import sys
import threading
import unittest
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from graphs import evidence_found, validate  # noqa: E402
from rag import Library, is_relevant, stem  # noqa: E402

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


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=str(server.WEB)))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=10) as r:
            return r.headers, r.read()

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

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


if __name__ == "__main__":
    unittest.main()
