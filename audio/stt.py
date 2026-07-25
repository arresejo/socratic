"""STT — whisper.cpp. Daemon-first (whisper-server keeps the 1.4 GB model
resident → ~1-2 s per answer), CLI fallback (reloads the model every call,
~10 s).

Env:
    WHISPER_SERVER_URL default http://127.0.0.1:8126 (daemon path)
    WHISPER_CPP_BIN    default "whisper-cli" (fallback path)
    WHISPER_CPP_MODEL  path to ggml model — required for the fallback
Requires ffmpeg on PATH (browser sends webm/opus; whisper wants 16 kHz wav).
"""

import os
import subprocess
import tempfile
from pathlib import Path

import httpx

WHISPER_SERVER_URL = os.environ.get("WHISPER_SERVER_URL", "http://127.0.0.1:8126")


def _to_wav(data: bytes, suffix: str, td: str) -> Path:
    src = Path(td) / f"input{suffix}"
    wav = Path(td) / "converted.wav"  # distinct name: input may itself be .wav
    src.write_bytes(data)
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-ar", "16000", "-ac", "1", str(wav)],
        check=True, capture_output=True,
    )
    return wav


def _server(wav: Path) -> str:
    with open(wav, "rb") as f:
        r = httpx.post(
            f"{WHISPER_SERVER_URL}/inference",
            files={"file": ("answer.wav", f, "audio/wav")},
            data={"response_format": "json", "language": "auto"},
            timeout=120,
        )
    r.raise_for_status()
    return r.json().get("text", "").strip()


def _cli(wav: Path) -> str:
    whisper_bin = os.environ.get("WHISPER_CPP_BIN", "whisper-cli")
    model = os.environ.get("WHISPER_CPP_MODEL")
    if not model:
        raise RuntimeError("WHISPER_CPP_MODEL is not set (path to a ggml model file)")
    proc = subprocess.run(
        [whisper_bin, "-m", model, "-f", str(wav), "-l", "auto", "-np", "-nt"],
        check=True, capture_output=True, text=True,
    )
    return proc.stdout.strip()


def transcribe_audio(data: bytes, suffix: str = ".webm") -> str:
    with tempfile.TemporaryDirectory() as td:
        wav = _to_wav(data, suffix, td)
        try:
            return _server(wav)
        except Exception:
            return _cli(wav)
