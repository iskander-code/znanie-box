"""Извлечение причинно-следственного графа из текста и его проверка.

Модель возвращает JSON по схеме (structured output Ollama). Затем код
проверяет каждую связь: есть ли её цитата в исходном тексте (нечётко — модель
меняет окончания, кавычки, регистр) и говорит ли цитата об обоих факторах.
Связи не удаляются: подтверждённые текстом получают verified: true, остальные —
verified: false и пометку «Требует проверки учителем». Учитель видит их на
черновике пунктиром и сам решает, оставить или убрать.
"""
from __future__ import annotations

import json
import re
from difflib import SequenceMatcher

import llm
from llm import chat

GRAPH_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "nodes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "label": {"type": "string"}},
                "required": ["id", "label"],
            },
        },
        "edges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "sign": {"type": "integer", "enum": [-1, 1]},
                    "strength": {"type": "integer", "enum": [1, 2, 3]},
                    "delay": {"type": "integer", "enum": [0, 1, 2]},
                    "evidence": {"type": "string"},
                },
                "required": ["from", "to", "sign", "strength", "delay", "evidence"],
            },
        },
    },
    "required": ["title", "nodes", "edges"],
}

EXTRACT_PROMPT = """Ты помогаешь учителю превратить параграф учебника в схему причин и следствий.

Шаг 1. Выдели из ТЕКСТА 4–10 факторов (узлов). Фактор — это то, чего может стать больше или меньше,
и назван он словами из ТЕКСТА (существительное из текста + «рост», «количество», «уровень» и т. п.).
Не придумывай факторов, которых нет в ТЕКСТЕ. Не используй события как узлы.
Даже если текст описательный (исторический или обзорный), найди в нём, что на что влияет.

Шаг 2. Свяжи факторы. Для каждой связи укажи:
- from, to — id узлов (латиница, коротко);
- sign: 1, если рост from увеличивает to; -1, если уменьшает;
- strength: 1 — слабая, 2 — средняя, 3 — сильная;
- delay: 0 — сразу, 1 — через некоторое время, 2 — через долгое время;
- evidence — точный фрагмент предложения из ТЕКСТА без изменений (5–15 слов), где говорится
  именно об этих двух факторах. У разных связей — разные цитаты.
Не добавляй связей, которых нет в ТЕКСТЕ. Ничего не бери из этой инструкции.

ТЕКСТ:
{text}"""


def _norm(s: str) -> str:
    """Только буквы и цифры в нижнем регистре, слова через один пробел."""
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-zа-я]+", " ", s.lower().replace("ё", "е"))).strip()


def _sentences(text: str) -> list[str]:
    return [x.strip() for x in re.findall(r"[^.!?\n]+[.!?]?", text) if x.strip()]


def _partial_ratio(short: str, long: str) -> float:
    """Как rapidfuzz.partial_ratio: насколько короткая строка похожа на лучший кусок длинной (0–1)."""
    if not short or not long:
        return 0.0
    if short in long:
        return 1.0
    if len(short) > len(long):
        short, long = long, short
    best = 0.0
    m = SequenceMatcher(None, long, short, autojunk=False)
    for block in m.get_matching_blocks():
        start = max(0, block.a - block.b)
        window = long[start:start + len(short)]
        best = max(best, SequenceMatcher(None, window, short, autojunk=False).ratio())
    return best


def _stem_overlap(evidence: str, passage: str) -> float:
    """Доля значимых слов цитаты (по началу слова), которые есть в отрывке."""
    ev = _stems5(evidence)
    return len(ev & _stems5(passage)) / len(ev) if ev else 0.0


def evidence_score(evidence: str, text: str) -> tuple[float, str]:
    """Насколько цитата совпадает с текстом (0–1) и самое похожее предложение текста."""
    ev = _norm(evidence)
    if not ev:
        return 0.0, ""
    best, best_sent = 0.0, ""
    for sent in _sentences(text):
        ns = _norm(sent)
        score = max(_partial_ratio(ev, ns), _stem_overlap(evidence, sent))
        if score > best:
            best, best_sent = score, sent
    if ev in _norm(text):
        best = 1.0
    return best, best_sent


def evidence_found(evidence: str, text: str, threshold: float = 0.65) -> bool:
    """Цитата есть в тексте с точностью до окончаний, кавычек, регистра и пунктуации."""
    return evidence_score(evidence, text)[0] >= threshold


def _stems5(s: str) -> set[str]:
    # Начало слова без окончания: «воды»/«вода» → «вод», «урожаи»/«урожайность» → «урожа».
    return {w[: max(3, min(5, len(w) - 1))] for w in re.findall(r"[а-яa-z]+", s.lower().replace("ё", "е")) if len(w) > 3}


def mentions(label: str, passage: str) -> bool:
    """Фактор упомянут в отрывке: совпадает начало хотя бы одного значимого слова."""
    return bool(_stems5(label) & _stems5(passage))


def _context(evidence: str, text: str) -> str:
    """Цитата вместе с предложением, в котором она стоит."""
    ev = _norm(evidence)
    for sent in re.findall(r"[^.!?]+[.!?]?", text):
        if ev and (ev in _norm(sent) or _norm(sent) in ev):
            return sent + " " + evidence
    return evidence


def validate(raw: dict, text: str) -> tuple[dict, list[str]]:
    """Чистит граф: проверяет цитаты, убирает дубликаты и узлы-сироты. Возвращает граф и замечания.

    Связь с неточной цитатой не удаляется, а помечается verified: false — её проверяет учитель.
    Удаляются только связи на несуществующие узлы, петли и повторы.
    """
    notes: list[str] = []
    nodes, seen = [], set()
    for n in raw.get("nodes", []):
        nid = re.sub(r"[^a-z0-9_]", "", str(n.get("id", "")).lower()) or f"n{len(nodes)}"
        if nid in seen or not str(n.get("label", "")).strip():
            continue
        seen.add(nid)
        nodes.append({"id": nid, "label": str(n["label"]).strip()[:60], "_raw": n.get("id")})
    id_map = {n["_raw"]: n["id"] for n in nodes}
    labels = {n["id"]: n["label"] for n in nodes}

    edges, pairs, review = [], set(), 0
    for e in raw.get("edges", []):
        a, b = id_map.get(e.get("from")), id_map.get(e.get("to"))
        if not a or not b or a == b:
            notes.append(f"Связь {e.get('from')}→{e.get('to')} ссылается на несуществующий узел — убрана")
            continue
        if (a, b) in pairs:
            continue
        pairs.add((a, b))
        evidence = str(e.get("evidence", "")).strip()
        score, sentence = evidence_score(evidence, text)
        if score < 0.3 and not mentions(labels[a], text) and not mentions(labels[b], text):
            # Ни цитаты, ни факторов в тексте нет — связь придумана, а не взята из параграфа.
            notes.append(f"Связь «{labels[a]} → {labels[b]}»: ни факторов, ни цитаты нет в тексте — убрана")
            continue
        passage = f"{sentence} {evidence}"
        both = mentions(labels[a], passage) and mentions(labels[b], passage)
        edge = {
            "from": a, "to": b,
            "sign": 1 if int(e.get("sign", 1)) >= 0 else -1,
            "strength": min(3, max(1, int(e.get("strength", 2)))),
            "delay": min(2, max(0, int(e.get("delay", 0)))),
            "evidence": evidence,
            "verified": score >= 0.65 and both,
        }
        if not edge["verified"]:
            review += 1
            missing = [labels[x] for x in (a, b) if not mentions(labels[x], text)]
            edge["review"] = (f"фактор «{missing[0]}» не упоминается в тексте" if missing else
                              "цитата не говорит об обоих факторах" if score >= 0.65 else
                              "цитата не найдена в тексте дословно" if evidence else "нет цитаты")
            if sentence and score >= 0.3:
                edge["sourceSentence"] = sentence  # ближайшее предложение текста — подсказка учителю
            notes.append(f"Связь «{labels[a]} → {labels[b]}»: {edge['review']} — требует проверки учителем")
        edges.append(edge)

    if review:
        notes.insert(0, f"Подтверждено текстом: {len(edges) - review} из {len(edges)} связей. "
                        f"Остальные {review} показаны пунктиром — проверьте их, поправьте или удалите.")
    used = {x for e in edges for x in (e["from"], e["to"])}
    removed = [n["label"] for n in nodes if n["id"] not in used]
    if removed:
        notes.append("Узлы без связей убраны: " + ", ".join(removed))
    nodes = [{"id": n["id"], "label": n["label"]} for n in nodes if n["id"] in used]
    with_incoming = {e["to"] for e in edges}
    for n in nodes:
        if n["id"] not in with_incoming:
            n["adjustable"] = True
    graph = {
        "id": "user-" + (re.sub(r"[^a-z0-9]", "", str(raw.get("title", "")).lower())[:12] or "graph"),
        "title": str(raw.get("title") or "Новая схема")[:80],
        "subject": "",
        "source": "Текст учителя",
        "verified_by_teacher": False,
        "delayLabels": ["сразу", "через время", "через долгое время"],
        "nodes": nodes,
        "edges": edges,
        "scenarios": [],
        "questions": [],
        "sourceText": text,
    }
    return graph, notes


IDEA_PROMPT = "Ты — Сова, доброжелательный наставник школьника. Ученик придумал свою идею (новый фактор или решение) для причинно-следственной схемы и соединил её стрелками с факторами схемы. Тебе пришлют JSON: схему, идею, связи, гипотезу ученика и последствия, которые посчитала модель. Ответь по-русски, не больше 6 предложений, в Markdown: 1) **похвали** за конкретный удачный или нестандартный ход; 2) оцени логику связей — верно ли направление «рост / уменьшение» и почему; 3) назови 1–2 возможных **побочных эффекта** или условия, при которых идея не сработает; 4) закончи ОДНИМ наводящим **вопросом**. Не ставь оценку «верно/неверно» и не пиши готовое решение за ученика."

SCENARIO_PROMPT = """Ученик пишет своё условие для причинно-следственной схемы «{title}»: «{text}».
Факторы схемы (id — название):
{nodes}
Определи, какие факторы схемы меняются по этому условию и в какую сторону. Ответь ТОЛЬКО JSON без пояснений:
{{"changes": [{{"id": "id фактора", "direction": 1 или -1, "strength": от 0.3 до 1}}], "note": "одно короткое предложение для ученика"}}
Если условие не про факторы схемы — верни {{"changes": [], "note": "..."}}."""


def idea_feedback(payload: dict) -> str:
    """Разбор идеи ученика нейросетью: похвала, логика связей, побочные эффекты, наводящий вопрос."""
    data = json.dumps({k: payload.get(k) for k in ("graph", "idea", "effects")}, ensure_ascii=False)[:6000]
    return llm.ask([{"role": "system", "content": IDEA_PROMPT}, {"role": "user", "content": data}], max_tokens=500)


def parse_scenario(graph: dict, text: str) -> dict:
    """Своё условие ученика → изменения узлов. Ответ нейросети проверяется: только существующие узлы."""
    nodes = {str(n.get("id")): str(n.get("label", "")) for n in graph.get("nodes", [])}
    prompt = SCENARIO_PROMPT.format(title=str(graph.get("title", ""))[:80], text=str(text)[:300],
                                    nodes="\n".join(f"{k} — {v}" for k, v in list(nodes.items())[:40]))
    raw = _parse_json(llm.ask([{"role": "user", "content": prompt}], max_tokens=300))
    changes = {}
    for c in raw.get("changes", [])[:6]:
        nid = str(c.get("id", ""))
        if nid in nodes:
            strength = min(1.0, max(0.3, float(c.get("strength", 0.6) or 0.6)))
            changes[nid] = round((1 if int(c.get("direction", 1)) >= 0 else -1) * strength, 2)
    return {"changes": changes, "note": str(raw.get("note", ""))[:200]}


JSON_TAIL = """

Ответь ТОЛЬКО JSON-объектом без пояснений и без ```, по схеме:
{"title": "...", "nodes": [{"id": "...", "label": "..."}],
 "edges": [{"from": "...", "to": "...", "sign": 1, "strength": 2, "delay": 0, "evidence": "..."}]}"""


def _parse_json(content: str) -> dict:
    """JSON из ответа онлайн-модели: убираем ```json-обёртку и текст вокруг объекта."""
    content = content.strip()
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Нейросеть не вернула схему в формате JSON")
    return json.loads(content[start:end + 1])


def extract(text: str) -> tuple[dict, list[str]]:
    """Строит схему выбранной нейросетью: онлайн (Claude, GPT, Gemini) или локальной через Ollama.

    Ollama получает строгую JSON-схему (structured output), онлайн-модели — описание формата в подсказке.
    Если онлайн-нейросеть недоступна, схему строит локальная модель.
    """
    prompt = EXTRACT_PROMPT.format(text=text)
    if llm.provider() != "local":
        try:
            return validate(_parse_json(llm.ask([{"role": "user", "content": prompt + JSON_TAIL}])), text)
        except (llm.OnlineUnavailable, ValueError) as e:
            if not llm.model():
                raise RuntimeError(f"Онлайн-нейросеть не построила схему: {e}") from e
    content = chat([{"role": "user", "content": prompt}], fmt=GRAPH_SCHEMA, temperature=0.1)
    return validate(json.loads(content), text)
