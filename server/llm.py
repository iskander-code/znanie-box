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
    pid = provider()
    return {"llm": available(), "model": label(), "localModel": m, "mode": "cloud" if API_KEY else "local", "device": device(),
            "provider": pid, "providers": online.available()}


# Без видеокарты модель поменьше отвечает в 2–2,5 раза быстрее (замер: python scripts/bench.py --weak).
FAST_CPU = "qwen2.5:3b"
_device: dict[str, str] = {}


def _payload(messages: list[dict], fmt: dict | None, temperature: float, max_tokens: int | None, stream: bool) -> dict:
    m = model()
    if not m:
        raise RuntimeError("Модель недоступна: запустите Ollama и скачайте модель (ollama pull qwen2.5:3b)")
    # keep_alive: модель не выгружается из памяти между уроками (иначе каждый вопрос после паузы ждёт 10–20 с загрузки);
    # num_ctx 4096 хватает на 3 фрагмента и историю, а памяти нужно меньше — важно для слабых устройств.
    options = {"temperature": temperature, "num_ctx": 4096}
    if max_tokens:
        options["num_predict"] = max_tokens  # предел длины: на слабом устройстве каждый лишний токен — это время
    payload = {"model": m, "messages": messages, "stream": stream, "keep_alive": "60m", "options": options}
    if fmt is not None:
        payload["format"] = fmt
    if m.startswith(THINKING):
        payload["think"] = False
    return payload


def chat(messages: list[dict], fmt: dict | None = None, temperature: float = 0.3, max_tokens: int | None = None) -> str:
    return _request("/api/chat", _payload(messages, fmt, temperature, max_tokens, False))["message"]["content"]


def chat_stream(messages: list[dict], temperature: float = 0.3, max_tokens: int | None = None):
    """Ответ по кусочкам, по мере того как модель его печатает: ученик видит первые слова сразу."""
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    data = json.dumps(_payload(messages, None, temperature, max_tokens, True)).encode("utf-8")
    req = urllib.request.Request(BASE_URL + "/api/chat", data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        for line in resp:
            if not line.strip():
                continue
            chunk = json.loads(line)
            if chunk.get("error"):
                raise RuntimeError(chunk["error"])
            piece = chunk.get("message", {}).get("content", "")
            if piece:
                yield piece
            if chunk.get("done"):
                break


def device() -> str | None:
    """'gpu' или 'cpu' — где работает модель (известно после прогрева)."""
    return _device.get("value")


def warm_up(log=print):
    """Загружает модель в память заранее и выбирает модель под железо.

    Если модель не задана явно (ZNANIE_MODEL) и работает без видеокарты, переключаемся на FAST_CPU:
    на процессоре она быстрее примерно в 2–2,5 раза.
    """
    m = model()
    if not m or API_KEY:
        return
    try:
        chat([{"role": "user", "content": "Привет"}], max_tokens=1)
        loaded = {x["name"]: x for x in _request("/api/ps", timeout=5).get("models", [])}
        on_gpu = loaded.get(m, {}).get("size_vram", 0) > 0
        _device["value"] = "gpu" if on_gpu else "cpu"
        installed = [x["name"] for x in _request("/api/tags", timeout=5).get("models", [])]
        if not on_gpu and not WANTED_MODEL and m != FAST_CPU and FAST_CPU in installed:
            # Выгружаем большую модель, чтобы не занимала память, и прогреваем быструю.
            _request("/api/generate", {"model": m, "keep_alive": 0}, timeout=30)
            _model_cache["name"] = FAST_CPU
            chat([{"role": "user", "content": "Привет"}], max_tokens=1)
            log(f"Нейросеть: видеокарты нет — для скорости взята модель {FAST_CPU} вместо {m}")
        else:
            log(f"Нейросеть: модель {model()} загружена ({'видеокарта' if on_gpu else 'процессор'})")
    except (urllib.error.URLError, OSError, ValueError, KeyError, RuntimeError) as e:
        log(f"Нейросеть: прогрев не удался ({e})")


# ---------- выбор нейросети для ответов Совы: локальная Qwen или онлайн по ключу ----------
import online  # noqa: E402

_provider = {"id": "local"}
FALLBACK_NOTE = "\n\n(Онлайн-нейросеть недоступна — ответила локальная модель.)"
REFUSED_TEXT = "Я не могу ответить на этот вопрос. Спроси учителя или родителей."


class OnlineUnavailable(RuntimeError):
    """Онлайн-нейросеть не ответила, а локальной модели нет."""


def provider() -> str:
    """'local' или id онлайн-нейросети. Если ключ убрали — снова локальная."""
    pid = _provider["id"]
    return pid if pid == "local" or any(p["id"] == pid for p in online.available()) else "local"


def set_provider(pid: str) -> str:
    if pid != "local" and not any(p["id"] == pid for p in online.available()):
        raise ValueError("Для этой нейросети на коробке не задан ключ")
    _provider["id"] = pid
    return provider()


def available() -> bool:
    """Есть ли чем отвечать: онлайн-нейросеть выбрана или локальная модель запущена."""
    return provider() != "local" or bool(model())


def label() -> str | None:
    """Название нейросети, которая сейчас отвечает, — для подписи под ответом."""
    pid = provider()
    return online.label(pid) if pid != "local" else model()


def ask_stream(messages: list[dict], max_tokens: int | None = None):
    """Ответ Совы по кусочкам выбранной нейросетью.

    Онлайн-нейросеть недоступна (нет интернета, ключ не подошёл, сервис упал) до первого слова —
    отвечает локальная модель, и в конце ответа есть пометка. Отказ по правилам безопасности
    локальной моделью не обходится.
    """
    pid = provider()
    if pid != "local":
        started = False
        try:
            for piece in online.stream(pid, messages):
                started = True
                yield piece
            return
        except online.Refused:
            if not started:
                yield REFUSED_TEXT
            return
        except Exception as e:  # noqa: BLE001 — любая сетевая ошибка: переходим на локальную модель
            if started or not model():
                raise OnlineUnavailable(f"{online.PROVIDERS[pid]['name']}: {online.describe(e)}") from e
        for piece in chat_stream(messages, max_tokens=max_tokens):
            yield piece
        yield FALLBACK_NOTE
        return
    yield from chat_stream(messages, max_tokens=max_tokens)


def ask(messages: list[dict], max_tokens: int | None = None) -> str:
    return "".join(ask_stream(messages, max_tokens))
