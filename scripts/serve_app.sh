#!/usr/bin/env bash
# Run the Socratic app (FastAPI + static frontend) on http://localhost:8123
set -euo pipefail
cd "$(dirname "$0")/.."

# LLM local — ollama natif par défaut (think:false supporté → éval ~5x plus rapide)
export SOCRATIC_LLM_BASE="${SOCRATIC_LLM_BASE:-http://localhost:11434}"
export SOCRATIC_LLM_MODEL="${SOCRATIC_LLM_MODEL:-gemma4:e4b}"
# Voix : whisper.cpp (STT, démon) + Kokoro (TTS neuronal) avec fallback say/Piper
export WHISPER_CPP_MODEL="${WHISPER_CPP_MODEL:-$PWD/data/models/ggml-medium.bin}"
export SAY_VOICE="${SAY_VOICE:-Samantha}"

# Démarre ollama (keep_alive infini: le modèle reste résident entre les checkpoints)
if ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:11434; then
  OLLAMA_KEEP_ALIVE=-1 OLLAMA_NUM_PARALLEL=3 nohup ollama serve < /dev/null >> data/ollama.log 2>&1 &
  echo "[serve_app] ollama daemon starting (data/ollama.log)"
fi

# Démarre le démon Kokoro s'il ne tourne pas déjà (venv 3.12 dédié)
if [ -x .venv-tts/bin/python ] && ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:8124; then
  nohup .venv-tts/bin/python audio/kokoro_server.py < /dev/null >> data/tts.log 2>&1 &
  echo "[serve_app] kokoro daemon starting (data/tts.log)"
fi

# Démarre whisper-server (modèle STT résident → ~1-2 s par réponse au lieu de ~10 s)
if command -v whisper-server >/dev/null && ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:8126; then
  nohup whisper-server -m "$WHISPER_CPP_MODEL" --host 127.0.0.1 --port 8126 --convert < /dev/null >> data/stt.log 2>&1 &
  echo "[serve_app] whisper daemon starting (data/stt.log)"
fi

# Bind: 127.0.0.1 par défaut (règle privacy de la spec). Pour une démo depuis un
# autre appareil du réseau local : SOCRATIC_HOST=0.0.0.0 ./scripts/serve_app.sh
# (les démons LLM/TTS/STT restent sur localhost — seul le frontend est exposé).
SOCRATIC_HOST="${SOCRATIC_HOST:-127.0.0.1}"

exec .venv/bin/uvicorn backend.main:app --host "$SOCRATIC_HOST" --port 8123 "$@"
