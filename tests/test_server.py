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

TEXT = (ROOT / "web" / "data" / "texts.json")


class RagTest(unittest.TestCase):
    def setUp(self):
        self.lib = Library(TEXT)

    def test_stem(self):
        self.assertEqual(stem("Температура"), "темпер")
        self.assertEqual(stem("ёлка"), "елка")

    def test_search_finds_relevant(self):
        fr = self.lib.search("почему повышают ключевую ставку")
        self.assertTrue(is_relevant(fr))
        self.assertIn(fr[0]["title"], {"Ключевая ставка и инфляция", "Инфляция"})

    def test_offtopic_is_not_relevant(self):
        self.assertFalse(is_relevant(self.lib.search("рецепт борща со сметаной")))


class GraphValidationTest(unittest.TestCase):
    TEXT = "Чем теплее вода, тем меньше кислорода в ней растворяется. Рыбам становится труднее дышать."

    def test_evidence_fuzzy(self):
        self.assertTrue(evidence_found("чем теплее вода тем меньше кислорода", self.TEXT))
        self.assertFalse(evidence_found("рыбы любят тёплую воду и солнце", self.TEXT))

    def test_validate_drops_unsupported_edges(self):
        raw = {
            "title": "Вода",
            "nodes": [{"id": "t", "label": "Температура"}, {"id": "o2", "label": "Кислород"}, {"id": "x", "label": "Солнце"}],
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
        r = self.post("/api/chat", {"message": "Почему крестьяне были недовольны?", "mode": "socratic", "level": 0})
        self.assertTrue(r["fragments"])
        self.assertTrue(r["fragments"][0]["relevant"])


if __name__ == "__main__":
    unittest.main()
