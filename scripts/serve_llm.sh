#!/usr/bin/env bash
# Serve the local LLM (llama.cpp, Metal) on localhost:8000 — OpenAI-compatible API.
# Primary target: Gemma 4 26B A4B instruct Q4 GGUF (Mac mini M4 Pro / 64 GB).
# Portable fallback: `ollama run gemma4:e4b` then export SOCRATIC_LLM_BASE/MODEL.
set -euo pipefail

MODEL_HF="${SOCRATIC_LLM_HF:-ggml-org/gemma-4-26b-a4b-it-GGUF:Q4_K_M}"

exec llama-server \
  -hf "$MODEL_HF" \
  -c 8192 \
  --host 127.0.0.1 \
  --port 8000
