"""Kokoro TTS daemon — neural, natural-sounding, fully local.

Runs in its own venv (.venv-tts, Python 3.12) because kokoro-onnx needs ≥3.10
while the app venv is 3.9. Loads the model ONCE and serves wav over localhost
(spec latency target <0.5 s per utterance would be impossible reloading 310 MB
per call).

    .venv-tts/bin/python audio/kokoro_server.py

Env:
    KOKORO_PORT   default 8124
    KOKORO_MODEL  default data/models/kokoro-v1.0.onnx
    KOKORO_VOICES default data/models/voices-v1.0.bin
    KOKORO_VOICE  default af_heart (natural en-US female; ff_siwis for French)
    KOKORO_SPEED  default 1.0
    KOKORO_LANG   default en-us
"""

import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent
MODEL = os.environ.get("KOKORO_MODEL", str(ROOT / "data/models/kokoro-v1.0.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", str(ROOT / "data/models/voices-v1.0.bin"))
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
LANG = os.environ.get("KOKORO_LANG", "en-us")
PORT = int(os.environ.get("KOKORO_PORT", "8124"))

print(f"[kokoro] loading {MODEL}…", flush=True)
kokoro = Kokoro(MODEL, VOICES)
print(f"[kokoro] ready on 127.0.0.1:{PORT} (voice={VOICE})", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # health check
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            samples, sr = kokoro.create(
                data.get("text", ""),
                voice=data.get("voice", VOICE),
                speed=float(data.get("speed", SPEED)),
                lang=data.get("lang", LANG),
            )
            buf = io.BytesIO()
            sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
            body = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa: BLE001
            msg = str(e).encode()
            self.send_response(500)
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, *args):  # keep the log quiet
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
