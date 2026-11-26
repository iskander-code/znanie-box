"""Извлечение причинно-следственного графа из текста и его проверка.

Модель возвращает JSON по схеме (structured output Ollama). Затем код
проверяет каждую связь: у неё должна быть цитата, которая действительно есть
в исходном тексте. Связи без подтверждения отбрасываются.
"""
from __future__ import annotations

import json
import re
from difflib import SequenceMatcher

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
Выдели 5–12 факторов (узлов). Узел — это величина, которая может расти или уменьшаться:
«Уровень моря», «Доходы крестьян», «Инфляция». Не используй события как узлы.
Для каждой связи укажи:
- from, to — id узлов (латиница, коротко);
- sign: 1, если рост from увеличивает to; -1, если уменьшает;
- strength: 1 — слабая, 2 — средняя, 3 — сильная;
- delay: 0 — сразу, 1 — через некоторое время, 2 — через долгое время;
- evidence — ДОСЛОВНАЯ цитата из текста (5–15 слов), на которой основана связь.
Не добавляй связей, которых нет в тексте.

Пример: текст «Чем теплее вода, тем меньше в ней кислорода» →
узлы t «Температура воды», o2 «Кислород в воде»; связь t→o2, sign -1, strength 2, delay 0,
evidence «Чем теплее вода, тем меньше в ней кислорода».

ТЕКСТ:
{text}"""


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[«»\"'.,;:!?()—–-]", " ", s.lower().replace("ё", "е"))).strip()


def evidence_found(evidence: str, text: str, threshold: float = 0.8) -> bool:
    """Цитата есть в тексте, допуская мелкие расхождения (падежи, пунктуация)."""
    ev, tx = _norm(evidence), _norm(text)
    if not ev:
        return False
    if ev in tx:
        return True
    m = SequenceMatcher(None, tx, ev, autojunk=False)
    covered = sum(b.size for b in m.get_matching_blocks())
    return covered / len(ev) >= threshold and m.find_longest_match(0, len(tx), 0, len(ev)).size >= len(ev) * 0.5


def validate(raw: dict, text: str) -> tuple[dict, list[str]]:
    """Чистит граф: убирает связи без цитаты, дубликаты, узлы-сироты. Возвращает граф и замечания."""
    notes: list[str] = []
    nodes, seen = [], set()
    for n in raw.get("nodes", []):
        nid = re.sub(r"[^a-z0-9_]", "", str(n.get("id", "")).lower()) or f"n{len(nodes)}"
        if nid in seen or not str(n.get("label", "")).strip():
            continue
        seen.add(nid)
        nodes.append({"id": nid, "label": str(n["label"]).strip()[:60], "_raw": n.get("id")})
    id_map = {n["_raw"]: n["id"] for n in nodes}

    edges, pairs = [], set()
    for e in raw.get("edges", []):
        a, b = id_map.get(e.get("from")), id_map.get(e.get("to"))
        if not a or not b or a == b:
            notes.append(f"Связь {e.get('from')}→{e.get('to')} ссылается на несуществующий узел — убрана")
            continue
        if (a, b) in pairs:
            continue
        if not evidence_found(str(e.get("evidence", "")), text):
            notes.append(f"Связь «{a}→{b}»: цитаты нет в тексте — убрана")
            continue
        pairs.add((a, b))
        edges.append({
            "from": a, "to": b,
            "sign": 1 if int(e.get("sign", 1)) >= 0 else -1,
            "strength": min(3, max(1, int(e.get("strength", 2)))),
            "delay": min(2, max(0, int(e.get("delay", 0)))),
            "evidence": str(e["evidence"]).strip(),
        })

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


def extract(text: str) -> tuple[dict, list[str]]:
    content = chat([{"role": "user", "content": EXTRACT_PROMPT.format(text=text)}], fmt=GRAPH_SCHEMA, temperature=0.1)
    return validate(json.loads(content), text)
