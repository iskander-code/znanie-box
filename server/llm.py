"""Клиент Ollama: локальная модель (основной режим) или Ollama Cloud по ключу.

Переменные окружения:
  ZNANIE_LLM_URL   адрес Ollama (по умолчанию http://127.0.0.1:11434,
                   а если задан OLLAMA_API_KEY — https://ollama.com)
  OLLAMA_API_KEY   ключ Ollama Cloud (только для демо с интернетом)
  ZNANIE_MODEL     имя модели; если не задано — лучшая из установленных (см. PREFERRED)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

API_KEY = os.environ.get("OLLAMA_API_KEY", "").strip()
BASE_URL = os.environ.get("ZNANIE_LLM_URL", "https://ollama.com" if API_KEY else "http://127.0.0.1:11434").rstrip("/")
WANTED_MODEL = os.environ.get("ZNANIE_MODEL", "")
# Если модель не задана — берём лучшую из установленных.
PREFERRED = ["qwen3.5:4b", "qwen3:4b", "qwen2.5:3b", "gemma3:4b", "gemma3:1b"]
# У «думающих» моделей отключаем размышления: иначе ответ идёт минутами.
THINKING = ("qwen3", "deepseek-r1", "magistral")

_model_cache: dict[str, str | None] = {}


def _request(path: str, payload: dict | None = None, timeout: float = 180) -> dict:
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def model() -> str | None:
    """Имя доступной модели или None, если Ollama недоступна."""
    if "name" in _model_cache:
        return _model_cache["name"]
    try:
        names = [m["name"] for m in _request("/api/tags", timeout=3).get("models", [])]
    except (urllib.error.URLError, OSError, ValueError):
        return None  # не кэшируем: Ollama могут запустить позже
    chosen = next((m for m in [WANTED_MODEL, *PREFERRED] if m and m in names), names[0] if names else None)
    if chosen:
        _model_cache["name"] = chosen
    return chosen


def status() -> dict:
    m = model()
    return {"llm": bool(m), "model": m, "mode": "cloud" if API_KEY else "local"}


def chat(messages: list[dict], fmt: dict | None = None, temperature: float = 0.3) -> str:
    m = model()
    if not m:
        raise RuntimeError("Модель недоступна: запустите Ollama и скачайте модель (ollama pull qwen2.5:3b)")
    payload = {"model": m, "messages": messages, "stream": False, "options": {"temperature": temperature}}
    if fmt is not None:
        payload["format"] = fmt
    if m.startswith(THINKING):
        payload["think"] = False
    return _request("/api/chat", payload)["message"]["content"]
