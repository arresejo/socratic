"""TTS wrapper — Kokoro (neural, natural) → Piper → macOS `say` fallback chain.

Kokoro runs as a local daemon (audio/kokoro_server.py, port 8124) because it
needs Python ≥3.10. Piper is the spec target; `say` is the zero-install
last resort.

Env:
    KOKORO_TTS_URL  default http://127.0.0.1:8124
    PIPER_BIN       default "piper"
    PIPER_VOICE     path to a .onnx voice model (enables the Piper path)
    SAY_VOICE       optional macOS voice name (e.g. "Samantha", "Thomas")
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

KOKORO_TTS_URL = os.environ.get("KOKORO_TTS_URL", "http://127.0.0.1:8124")


def _kokoro(text: str) -> bytes:
    r = httpx.post(KOKORO_TTS_URL, json={"text": text}, timeout=60)
    r.raise_for_status()
    return r.content


def _piper(text: str) -> bytes:
    piper_bin = os.environ.get("PIPER_BIN", "piper")
    voice = os.environ.get("PIPER_VOICE")
    if not voice or not shutil.which(piper_bin):
        raise RuntimeError("piper not available")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.wav"
        subprocess.run(
            [piper_bin, "--model", voice, "--output_file", str(out)],
            input=text.encode("utf-8"), check=True, capture_output=True,
        )
        return out.read_bytes()


def _say(text: str) -> bytes:
    """macOS built-in TTS → wav (say + afconvert both ship with macOS)."""
    if not shutil.which("say"):
        raise RuntimeError("say not available")
    voice = os.environ.get("SAY_VOICE")
    with tempfile.TemporaryDirectory() as td:
        aiff = Path(td) / "out.aiff"
        wav = Path(td) / "out.wav"
        cmd = ["say", "-o", str(aiff)]
        if voice:
            cmd += ["-v", voice]
        cmd.append(text)
        subprocess.run(cmd, check=True, capture_output=True)
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@22050", str(aiff), str(wav)],
            check=True, capture_output=True,
        )
        return wav.read_bytes()


def synthesize(text: str) -> bytes:
    for backend in (_kokoro, _piper, _say):
        try:
            return backend(text)
        except Exception:
            continue
    raise RuntimeError("no TTS backend available (kokoro daemon down, piper and say missing)")
