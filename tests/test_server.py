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
        self.assertEqual(len(self.lib.docs), 700)

    def test_offtopic_is_not_relevant(self):
        for q in ("рецепт борща со сметаной", "Почему небо голубое?", "Сколько будет 2+2?"):
            self.assertFalse(is_relevant(self.lib.search(q)), q)
        self.assertTrue(is_relevant(self.lib.search("Почему высохло Аральское море?")))


class GraphValidationTest(unittest.TestCase):
    TEXT = "Чем теплее вода, тем меньше кислорода в ней растворяется. Рыбам становится труднее дышать."

    def test_evidence_fuzzy(self):
        self.assertTrue(evidence_found("чем теплее вода тем меньше кислорода", self.TEXT))
        self.assertFalse(evidence_found("рыбы любят тёплую воду и солнце", self.TEXT))

    def test_validate_keeps_unverified_edges_for_teacher(self):
        raw = {
            "title": "Вода",
            "nodes": [{"id": "t", "label": "Температура воды"}, {"id": "o2", "label": "Кислород"}, {"id": "x", "label": "Солнце"}],
            "edges": [
                {"from": "t", "to": "o2", "sign": -1, "strength": 2, "delay": 0, "evidence": "«Чем теплее вода — тем меньше кислорода»"},
                {"from": "x", "to": "t", "sign": 1, "strength": 2, "delay": 0, "evidence": "солнце нагревает воду летом"},
                {"from": "t", "to": "zz", "sign": 1, "strength": 2, "delay": 0, "evidence": "Рыбам становится труднее"},
            ],
        }
        g, notes = validate(raw, self.TEXT)
        self.assertEqual([(e["from"], e["to"], e["verified"]) for e in g["edges"]], [("t", "o2", True), ("x", "t", False)],
                         "неточная цитата не удаляет связь, а помечает её; связь на несуществующий узел убрана")
        self.assertEqual(g["edges"][1]["review"], "фактор «Солнце» не упоминается в тексте")
        self.assertIn("Подтверждено текстом: 1 из 2", notes[0])
        self.assertTrue(any("несуществующий узел" in n for n in notes))

    def test_validate_flags_quote_about_other_factors(self):
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
        self.assertEqual([e["verified"] for e in g["edges"]], [True, False, True])
        self.assertEqual(g["edges"][1]["review"], "цитата не говорит об обоих факторах")

    def test_online_model_builds_schema_from_json_reply(self):
        from unittest import mock
        import graphs
        reply = '```json\n{"title": "Вода", "nodes": [{"id": "t", "label": "Температура воды"}, {"id": "o2", "label": "Кислород"}], ' \
                '"edges": [{"from": "t", "to": "o2", "sign": -1, "strength": 2, "delay": 0, "evidence": "Чем теплее вода, тем меньше кислорода"}]}\n```'
        with mock.patch.object(graphs.llm, "provider", return_value="gemini"), mock.patch.object(graphs.llm, "ask", return_value=reply) as ask, \
                mock.patch.object(graphs, "chat", side_effect=AssertionError("локальная модель не нужна")):
            g, _ = graphs.extract(self.TEXT)
        self.assertIn("JSON", ask.call_args[0][0][0]["content"])
        self.assertEqual([(e["from"], e["to"], e["verified"]) for e in g["edges"]], [("t", "o2", True)])

    def test_validate_descriptive_history_text(self):
        """Описательный текст и слегка изменённые моделью цитаты — схема не пустая."""
        text = ("Великий шёлковый путь проходил через юг Казахстана. Благодаря торговле на нём выросли города Отрар и Тараз. "
                "Купцы привозили шёлк и пряности, а вместе с ними распространялись знания и религии.")
        raw = {"title": "Шёлковый путь", "nodes": [{"id": "trade", "label": "Торговля"}, {"id": "cities", "label": "Рост городов"},
                                                   {"id": "know", "label": "Распространение знаний"}],
               "edges": [{"from": "trade", "to": "cities", "sign": 1, "strength": 3, "delay": 1, "evidence": "Благодаря торговле выросли города"},
                         {"from": "trade", "to": "know", "sign": 1, "strength": 2, "delay": 2, "evidence": "вместе с купцами распространялись знания"}]}
        g, _ = validate(raw, text)
        self.assertEqual(len(g["edges"]), 2, "схема не пустая: обе связи на черновике")
        self.assertTrue(g["edges"][0]["verified"], "цитата с другими окончаниями засчитана")
        # Во втором предложении говорится о купцах, а не о «торговле» — связь остаётся, но на проверку учителю.
        self.assertFalse(g["edges"][1]["verified"])


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
        from cache import AnswerCache
        server.CACHE = AnswerCache(Path(cls.tmp.name) / "cache.sqlite")
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

    def test_static_files_are_gzipped(self):
        import gzip
        req = urllib.request.Request(self.base + "/data/library/biology.json?x=1", headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.headers["Content-Encoding"], "gzip")
            self.assertIn("json", r.headers["Content-Type"])
            raw = r.read()
        plain = (self.server.WEB / "data" / "library" / "biology.json").read_bytes()
        self.assertEqual(gzip.decompress(raw), plain)
        self.assertLess(len(raw), len(plain) / 2, "сжатие хотя бы вдвое")
        _, body = self.get("/data/library/biology.json")  # без Accept-Encoding — обычный файл
        self.assertEqual(body, plain)

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
            self.server.CACHE.clear()  # тот же вопрос иначе пришёл бы из кэша
            pieces = ["Уровень упал из-за орошения."]
            _, lines = self.stream({"message": "Почему высохло Аральское море?", "mode": "socratic", "level": 0})
            self.assertIsNone(lines[-1]["answer"])
            # Вопрос не по библиотеке — ответ «из знаний нейросети» с пометкой general.
            pieces = ["Из-за рассеяния света."]
            _, lines = self.stream({"message": "Почему небо голубое?", "mode": "socratic", "level": 0})
            self.assertTrue(lines[0]["general"])
            self.assertEqual(lines[-1]["answer"], "Из-за рассеяния света.")
        self.assertEqual(calls, [160, 160, 450], "подсказка короче ответа ученику (450 токенов)")

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

    def test_same_question_is_answered_from_cache(self):
        from unittest import mock
        import time as _time
        llm = self.server.llm
        calls = []

        def fake_stream(msgs, max_tokens=None):
            calls.append(max_tokens)
            yield from ["Подумай, ", "что такое сопротивление?"]

        q = {"message": "Что такое закон Ома?", "mode": "socratic", "level": 0, "grade": 8}
        with mock.patch.object(llm, "model", return_value="fake-cache"), mock.patch.object(llm, "chat_stream", fake_stream):
            _, first = self.stream(q)
            t0 = _time.perf_counter()
            _, second = self.stream(q)
            dt = _time.perf_counter() - t0
            r = self.post("/api/chat", q)  # и обычный запрос без потока
        self.assertEqual(len(calls), 1, "повторный вопрос не идёт в нейросеть")
        self.assertEqual(calls[0], 160, "подсказка короче объяснения")
        self.assertTrue(second[0].get("cached") and second[-1]["answer"] == first[-1]["answer"])
        self.assertTrue(r.get("cached"))
        self.assertLess(dt, 0.5)
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        self.assertGreaterEqual(self.post("/api/teacher/clear-cache", {}, token)["removed"], 1)

    def test_change_pin_and_simulation_analytics(self):
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        self.assertEqual(self.status("/api/teacher/pin", {"old": "2026", "new": "4815"}), 403, "без входа PIN не сменить")
        self.assertEqual(self.status("/api/teacher/pin", {"old": "1111", "new": "4815"}, token), 400, "нужен верный старый PIN")
        self.assertEqual(self.status("/api/teacher/pin", {"old": "2026", "new": "12"}, token), 400)
        try:
            self.assertTrue(self.post("/api/teacher/pin", {"old": "2026", "new": "4815"}, token)["ok"])
            self.assertEqual(self.status("/api/teacher/login", {"pin": "2026"}), 403, "старый PIN больше не подходит")
            token = self.post("/api/teacher/login", {"pin": "4815"})["token"]
            state = json.loads(self.server.TEACHER.file.read_text(encoding="utf-8"))
            self.assertNotIn("4815", json.dumps(state), "в файле только хэш PIN")
        finally:
            self.post("/api/teacher/pin", {"old": "4815", "new": "2026"}, token)
        self.post("/api/report-sim", {"graphId": "aral", "title": "Арал", "total": 3, "wrong": ["Солёность воды"]})
        self.post("/api/report-sim", {"graphId": "aral", "title": "Арал", "total": 2, "wrong": ["Солёность воды", "Рыба в море"]})
        req = urllib.request.Request(self.base + "/api/teacher/summary", headers={"X-Teacher-Token": token})
        with urllib.request.urlopen(req, timeout=10) as r:
            sims = json.loads(r.read())["sims"]
        aral = next(x for x in sims if x["graphId"] == "aral")
        self.assertEqual((aral["runs"], aral["predictions"], aral["wrong"], aral["errorRate"]), (2, 5, 3, 0.6))
        self.assertEqual(aral["hardest"][0], "Солёность воды")

    def test_idea_and_scenario_with_model(self):
        from unittest import mock
        llm = self.server.llm
        graph = {"title": "Арал", "nodes": [{"id": "dam", "label": "Плотина"}, {"id": "level", "label": "Уровень моря"}], "edges": []}
        with mock.patch.object(llm, "model", return_value=None), mock.patch.object(llm, "provider", return_value="local"):
            self.assertFalse(self.post("/api/idea", {"graph": graph, "idea": {"label": "x"}})["llm"], "без нейросети — разбор в браузере")
            self.assertEqual(self.post("/api/scenario", {"graph": graph, "text": "построили плотину"})["changes"], {})
        replies = iter([
            "**Отличная идея!** Подумай: откуда деревья возьмут воду в первые 3 года?",
            '```json\n{"changes": [{"id": "dam", "direction": 1, "strength": 0.8}, {"id": "nope", "direction": -1}], "note": "Плотина поднимет уровень."}\n```',
        ])
        with mock.patch.object(llm, "model", return_value="fake"), mock.patch.object(llm, "ask", side_effect=lambda *a, **k: next(replies)) as ask:
            r = self.post("/api/idea", {"graph": graph, "idea": {"label": "Лесополосы", "hypothesis": "задержат воду"}, "effects": ["▲ Уровень моря"]})
            self.assertIn("откуда деревья", r["answer"])
            self.assertIn("побочн", ask.call_args_list[0][0][0][0]["content"], "Сова ищет побочные эффекты")
            s = self.post("/api/scenario", {"graph": graph, "text": "Что, если построили плотину?"})
        self.assertEqual(s["changes"], {"dam": 0.8}, "несуществующие узлы отброшены")
        self.assertEqual(s["note"], "Плотина поднимет уровень.")

    def test_teacher_sims_folder(self):
        import shutil
        extra = self.server.WEB / "sims" / "zz-teacher-test.html"
        shutil.copy(self.server.WEB / "phet" / "hookes-law.html", extra)
        try:
            _, raw = self.get("/api/sims")
            sims = json.loads(raw)
        finally:
            extra.unlink()
        mine = [x for x in sims if x["src"] == "sims/zz-teacher-test.html"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["title"], "Закон Гука", "название из <title> файла PhET")
        self.assertFalse(any(x["src"] == "sims/ohm-law.html" for x in sims), "свои симуляторы уже в каталоге")

    def test_context_from_library_is_capped(self):
        long = [{"title": f"Тема {i}", "text": "слово " * 400} for i in range(3)]
        system = self.server.tutor_messages({"message": "?", "mode": "explain"}, long)[0]["content"]
        context = system.split("ФРАГМЕНТЫ:\n", 1)[1]
        self.assertLessEqual(len(context), 1500 + 10)

    def test_teacher_ai_answers_any_question_from_model_knowledge(self):
        from unittest import mock
        self.assertEqual(self.status("/api/teacher/ask", {"message": "План урока"}), 403)
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        seen = []

        def fake_stream(msgs, max_tokens=None):
            seen.append(msgs)
            yield from ["1. Разминка. ", "2. Опыт."]

        llm = self.server.llm
        with mock.patch.object(llm, "model", return_value="fake"), mock.patch.object(llm, "chat_stream", fake_stream):
            req = urllib.request.Request(self.base + "/api/teacher/ask", headers={"Content-Type": "application/json", "X-Teacher-Token": token},
                                         data=json.dumps({"message": "Составь план урока про вулканы", "stream": True}).encode())
            with urllib.request.urlopen(req, timeout=30) as r:
                lines = [json.loads(x) for x in r if x.strip()]
        self.assertEqual(lines[-1]["answer"], "1. Разминка. 2. Опыт.")
        system = seen[0][0]["content"]
        self.assertIn("из своих знаний", system)
        self.assertNotIn("ФРАГМЕНТЫ", system, "помощник учителя не опирается на библиотеку сайта")
        self.assertEqual(seen[0][-1], {"role": "user", "content": "Составь план урока про вулканы"})

    def test_key_from_teacher_cabinet(self):
        from unittest import mock
        import os
        online = self.server.llm.online
        secret = "sk-test-0123456789abcd"
        self.assertEqual(self.status("/api/teacher/keys", {"provider": "openai", "key": secret}), 403)
        token = self.post("/api/teacher/login", {"pin": "2026"})["token"]
        with tempfile.TemporaryDirectory() as d, mock.patch.object(online, "KEYS_FILE", Path(d) / "keys.json"), \
                mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}), \
                mock.patch.dict(online.PROVIDERS["openai"], {"url": "http://127.0.0.1:9"}):
            self.assertEqual(self.status("/api/teacher/keys", {"provider": "openai", "key": "short"}, token), 400)
            r = self.post("/api/teacher/keys", {"provider": "openai", "key": secret}, token)
            gpt = next(p for p in r["online"] if p["id"] == "openai")
            self.assertTrue(gpt["hasKey"])
            self.assertEqual(gpt["masked"], "…abcd")
            self.assertEqual(gpt["source"], "saved")
            _, raw = self.get("/api/health")
            self.assertNotIn(secret, raw.decode(), "полный ключ не уходит на страницу")
            self.assertNotIn(secret, json.dumps(r))
            self.assertIn(secret, (Path(d) / "keys.json").read_text(encoding="utf-8"), "ключ сохранён на коробке")
            self.assertEqual(self.post("/api/settings", {"provider": "openai"}, token)["provider"], "openai")
            t = self.post("/api/teacher/test-key", {"provider": "openai"}, token)
            self.assertFalse(t["ok"])
            self.assertEqual(t["error"], "нет связи с интернетом")
            r = self.post("/api/teacher/keys", {"provider": "openai", "key": ""}, token)
            self.assertFalse(next(p for p in r["online"] if p["id"] == "openai")["hasKey"])
            self.assertEqual(r["provider"], "local", "без ключа снова отвечает локальная модель")

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
        self.assertIn("/models/gemini-4-hydrogen:", p3, "модель Gemini по умолчанию")
        self.assertEqual(b3["generationConfig"]["thinkingConfig"], {"thinkingLevel": "low"})

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
