"""Онлайн-нейросети по ключу: Claude (Anthropic), GPT (OpenAI), Gemini (Google).

Необязательный режим для показа с интернетом. Основной режим — локальная Qwen без интернета:
если ключа нет, интернета нет или онлайн-сервис ответил ошибкой, Сова отвечает локальной моделью.

Ключ проще всего вставить в кабинете учителя (блок «Какая нейросеть отвечает»): он сохраняется
в data/keys.json на коробке. Можно задать и переменной окружения. На страницу ключ не попадает —
показываются только последние 4 символа.
  ANTHROPIC_API_KEY   Claude    модель: ZNANIE_CLAUDE_MODEL  (по умолчанию claude-opus-5-5)
  OPENAI_API_KEY      GPT       модель: ZNANIE_OPENAI_MODEL  (по умолчанию gpt-5-mini)
  GEMINI_API_KEY      Gemini    модель: ZNANIE_GEMINI_MODEL  (по умолчанию gemini-4-hydrogen)

Запросы идут напрямую по HTTPS стандартной библиотекой Python — как и весь сервер,
без внешних пакетов (коробка ставится без pip и без интернета).
"""
from __future__ import annotations

import json
import os
import threading
import urllib.parse
import urllib.request
from pathlib import Path

# Ответы Совы короткие (до 5–6 предложений, это задано в подсказке). Запас нужен потому, что у
# «думающих» моделей рассуждение тоже расходует этот предел: слишком маленький обрежет ответ.
MAX_TOKENS = 4096
TIMEOUT = 60

PROVIDERS = {
    "claude": {"name": "Claude", "key": "ANTHROPIC_API_KEY", "model_env": "ZNANIE_CLAUDE_MODEL", "model": "claude-opus-5-5",
               "url": os.environ.get("ZNANIE_CLAUDE_URL", "https://api.anthropic.com")},
    "openai": {"name": "GPT", "key": "OPENAI_API_KEY", "model_env": "ZNANIE_OPENAI_MODEL", "model": "gpt-5-mini",
               "url": os.environ.get("ZNANIE_OPENAI_URL", "https://api.openai.com")},
    "gemini": {"name": "Gemini", "key": "GEMINI_API_KEY", "model_env": "ZNANIE_GEMINI_MODEL", "model": "gemini-4-hydrogen",
               "url": os.environ.get("ZNANIE_GEMINI_URL", "https://generativelanguage.googleapis.com")},
}


KEYS_FILE = Path(__file__).resolve().parent.parent / "data" / "keys.json"
_keys_lock = threading.Lock()


def _saved() -> dict:
    try:
        return json.loads(KEYS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def set_key(pid: str, key: str):
    """Сохранить ключ, введённый в кабинете учителя. Пустой ключ — удалить."""
    if pid not in PROVIDERS:
        raise ValueError("Неизвестная нейросеть")
    key = key.strip()
    if key and (len(key) < 10 or any(c.isspace() for c in key)):
        raise ValueError("Похоже, ключ вставлен не полностью или с пробелами")
    with _keys_lock:
        keys = _saved()
        if key:
            keys[pid] = key
        else:
            keys.pop(pid, None)
        KEYS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = KEYS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(keys), encoding="utf-8")
        tmp.replace(KEYS_FILE)


def _key(pid: str) -> str:
    """Ключ из кабинета учителя, иначе из переменной окружения."""
    return (_saved().get(pid) or os.environ.get(PROVIDERS[pid]["key"], "")).strip()


def status() -> list[dict]:
    """Все онлайн-нейросети для кабинета учителя: есть ли ключ и откуда (сам ключ не отдаётся)."""
    saved = _saved()
    out = []
    for pid, p in PROVIDERS.items():
        key = _key(pid)
        out.append({"id": pid, "name": p["name"], "model": model_of(pid), "hasKey": bool(key),
                    "masked": f"…{key[-4:]}" if key else "", "source": "saved" if saved.get(pid) else "env" if key else "",
                    "env": p["key"]})
    return out


def test(pid: str) -> str:
    """Короткий пробный запрос: подошёл ли ключ. Возвращает начало ответа или поднимает ошибку."""
    text = ""
    for piece in stream(pid, [{"role": "user", "content": "Ответь одним словом по-русски: готово"}]):
        text += piece
        if len(text) > 40:
            break
    return text.strip() or "(пустой ответ)"


def model_of(pid: str) -> str:
    p = PROVIDERS[pid]
    return os.environ.get(p["model_env"], "").strip() or p["model"]


def available() -> list[dict]:
    """Онлайн-нейросети, для которых на коробке задан ключ."""
    return [{"id": pid, "name": p["name"], "model": model_of(pid)} for pid, p in PROVIDERS.items() if _key(pid)]


def label(pid: str) -> str:
    return f"{PROVIDERS[pid]['name']} {model_of(pid)} (онлайн)"


def _split_system(messages: list[dict]) -> tuple[str, list[dict]]:
    """Все системные указания — в одно поле (так их принимают Claude и Gemini), остальное — диалог."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    dialog = [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] in ("user", "assistant")]
    return system, dialog


def _sse(req: urllib.request.Request):
    """Читает поток Server-Sent Events и отдаёт данные каждого события как dict."""
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            yield json.loads(data)


def _post(url: str, headers: dict, body: dict) -> urllib.request.Request:
    return urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                  headers={"Content-Type": "application/json", **headers}, method="POST")


class Refused(RuntimeError):
    """Онлайн-модель отказалась отвечать по своим правилам безопасности."""


def _claude(messages: list[dict]):
    system, dialog = _split_system(messages)
    body = {
        "model": model_of("claude"), "max_tokens": MAX_TOKENS, "stream": True,
        "system": system, "messages": dialog,
        # Короткий школьный ответ не требует долгих рассуждений: низкое усилие — быстрее.
        "output_config": {"effort": "low"},
        # Если модель откажется по правилам безопасности, сервис сам повторит запрос на запасной модели.
        "fallbacks": "default",
    }
    req = _post(PROVIDERS["claude"]["url"] + "/v1/messages", {
        "x-api-key": _key("claude"), "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
    }, body)
    for ev in _sse(req):
        kind = ev.get("type")
        if kind == "content_block_delta" and ev["delta"].get("type") == "text_delta":
            yield ev["delta"]["text"]
        elif kind == "message_delta" and ev.get("delta", {}).get("stop_reason") == "refusal":
            raise Refused("Claude отказался отвечать на этот вопрос")
        elif kind == "error":
            raise RuntimeError(ev.get("error", {}).get("message", "ошибка Claude"))


def _openai(messages: list[dict]):
    m = model_of("openai")
    body = {"model": m, "messages": [{"role": x["role"], "content": x["content"]} for x in messages],
            "stream": True, "max_completion_tokens": MAX_TOKENS}
    if m.startswith(("gpt-5", "o")):
        body["reasoning_effort"] = "low"  # у «думающих» моделей OpenAI — короче рассуждение, быстрее ответ
    req = _post(PROVIDERS["openai"]["url"] + "/v1/chat/completions", {"Authorization": f"Bearer {_key('openai')}"}, body)
    for ev in _sse(req):
        if ev.get("error"):
            raise RuntimeError(ev["error"].get("message", "ошибка OpenAI"))
        for choice in ev.get("choices", []):
            piece = (choice.get("delta") or {}).get("content")
            if piece:
                yield piece


def _gemini(messages: list[dict]):
    m = model_of("gemini")
    system, dialog = _split_system(messages)
    config = {"maxOutputTokens": MAX_TOKENS}
    if m.startswith(("gemini-3", "gemini-4")):
        # Уровни рассуждения low / medium / high (по умолчанию) / xhigh; для короткого школьного ответа хватает low.
        config["thinkingConfig"] = {"thinkingLevel": "low"}
    elif "flash" in m:
        config["thinkingConfig"] = {"thinkingBudget": 0}  # у Gemini 2.5 Flash рассуждение можно выключить
    body = {
        "contents": [{"role": "model" if x["role"] == "assistant" else "user", "parts": [{"text": x["content"]}]} for x in dialog],
        "generationConfig": config,
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    url = f"{PROVIDERS['gemini']['url']}/v1beta/models/{urllib.parse.quote(m)}:streamGenerateContent?alt=sse"
    req = _post(url, {"x-goog-api-key": _key("gemini")}, body)
    for ev in _sse(req):
        if ev.get("error"):
            raise RuntimeError(ev["error"].get("message", "ошибка Gemini"))
        for cand in ev.get("candidates", []):
            if cand.get("finishReason") in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
                raise Refused("Gemini отказался отвечать на этот вопрос")
            for part in (cand.get("content") or {}).get("parts", []):
                if part.get("text") and not part.get("thought"):
                    yield part["text"]


def describe(err: Exception) -> str:
    """Причина сбоя понятными словами — для пометки под ответом."""
    import urllib.error
    if isinstance(err, urllib.error.HTTPError):
        return {401: "ключ не подошёл", 403: "доступ по ключу запрещён", 429: "превышен лимит запросов"}.get(
            err.code, f"сервис ответил ошибкой {err.code}")
    if isinstance(err, (urllib.error.URLError, TimeoutError, OSError)):
        return "нет связи с интернетом"
    return "сервис не ответил"


_STREAMERS = {"claude": _claude, "openai": _openai, "gemini": _gemini}


def stream(pid: str, messages: list[dict]):
    """Ответ онлайн-нейросети по кусочкам. Ошибки сети и сервиса поднимаются наружу."""
    if pid not in _STREAMERS or not _key(pid):
        raise RuntimeError(f"Нет ключа для {pid}")
    yield from _STREAMERS[pid](messages)
