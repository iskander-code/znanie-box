"""Озвучка текста через Piper TTS (локально, без интернета) — если он установлен.

Переменные окружения:
  ZNANIE_PIPER        путь к программе piper (piper.exe), по умолчанию ищется в PATH
  ZNANIE_PIPER_VOICE  путь к русскому голосу .onnx (например ru_RU-irina-medium.onnx)

Если Piper не найден, сайт озвучивает текст встроенным голосом браузера (speechSynthesis).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

PIPER = os.environ.get("ZNANIE_PIPER") or shutil.which("piper") or ""
VOICE = os.environ.get("ZNANIE_PIPER_VOICE", "")
MAX_CHARS = 3000


def available() -> bool:
    return bool(PIPER and Path(PIPER).exists() and VOICE and Path(VOICE).exists())


def synthesize(text: str) -> bytes:
    """Возвращает WAV-файл с озвученным текстом."""
    if not available():
        raise RuntimeError("Piper не установлен")
    text = " ".join(str(text).split())[:MAX_CHARS]
    if not text:
        raise ValueError("Пустой текст")
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "speech.wav"
        subprocess.run([PIPER, "--model", VOICE, "--output_file", str(out)], input=text.encode("utf-8"),
                       capture_output=True, timeout=60, check=True)
        return out.read_bytes()
