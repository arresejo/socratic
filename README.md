# Socratic — the video that quizzes you back

**Paris Gemma 4 Hackathon 2026 · Track 1 — Edge / On-Device**

A local-first active-learning tutor for YouTube. The video auto-pauses at key
concepts, asks you a question **out loud**, listens to your spoken answer,
grades it against the transcript with a structured rubric, corrects you with a
fresh explanation, and resumes. Passive watching becomes a Socratic dialogue.

**Everything runs on this machine**: Gemma 4 (LLM), whisper.cpp (STT),
Kokoro (TTS). After the transcript fetch, no data leaves your disk.

## Why on-device is constitutive (not cosmetic)

- **Privacy** — the system's core data is your *map of ignorance*: wrong
  answers, hesitations, knowledge gaps, stored in an append-only local profile.
  Nobody wants that in a cloud.
- **Unlimited questioning, $0** — a one-hour lecture means dozens of LLM calls
  (segmentation, grading, re-explanation). Local inference makes it free,
  forever — no metered bill on your curiosity.
- **Latency** — precomputed checkpoints (0 ms at pause time), question audio
  pre-synthesized at build time, answer→verdict ≈ 5 s all-local.

## How Gemma 4 is used (4 distinct roles)

| Role | When | Thinking | Guardrail |
|---|---|---|---|
| **Segmenter** | offline, at session build | ON (quality) | pydantic + retry, intro guard, gap/cap, per-bucket depth selection |
| **Self-check** | offline, after segmentation | OFF, temp 0 | prunes rubric criteria the source span doesn't actually teach |
| **Evaluator** | live, after each answer | OFF (fast path) | **evidence enforcement**: a point only counts if its quote is verbatim from the learner's answer; fabricated evidence → automatic escalation to the thinking path |
| **Re-explainer / follow-up** | live, on partial/miss | OFF | language-of-the-video, profile-calibrated |

The evaluator design is the heart of the grading integrity: a rubric per key
point with evidence quotes, checked *mechanically* — never a free-form
"is this good?".

## Architecture

```
YouTube URL → transcript (youtube-transcript-api, whisper.cpp fallback)
           → SEGMENTER (Gemma 4, sliding windows) → session.json (precomputed)
           → player (YouTube iframe) + overlay state machine
           → voice loop: Kokoro TTS → mic/VAD → whisper.cpp STT
           → EVALUATOR (Gemma 4, rubric + evidence enforcement)
           → pass: resume | partial: ONE follow-up | miss: re-explain + replay
           → local profile (append-only JSONL) → session recap
```

## Two clients

- **Web app** (`frontend/`) — served by the backend at `http://localhost:8123`;
  YouTube iframe + full voice loop.
- **Chrome extension** (`extension/`) — injects the whole Socratic loop into the
  **real YouTube player**: checkpoint dots rendered directly on the progress bar
  (chapter-aware), auto-pause + spoken question in a lower-third card, verdict
  chips, click a dot to retry, end-of-session report with weak spots first.
  Load it via `chrome://extensions` → Developer mode → "Load unpacked" → select
  `extension/` (the backend must be running).

## Run it

```bash
# 0. Prereqs: ollama (gemma4:e4b pulled), brew install whisper-cpp ffmpeg,
#    a whisper model in data/models/, optional Kokoro model for neural TTS
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 1. Everything (ollama + kokoro + whisper daemons + app) in one script:
./scripts/serve_app.sh          # → http://localhost:8123

# Or build a session from the CLI (M1):
python -m backend.cli "https://www.youtube.com/watch?v=aircAruvnKk"
```

Env overrides: `SOCRATIC_LLM_BASE` (default native ollama `localhost:11434`),
`SOCRATIC_LLM_MODEL` (default `gemma4:e4b`), `WHISPER_CPP_MODEL`,
`KOKORO_VOICE`, `SAY_VOICE`.

## Demo flow (what to try)

1. Paste a YouTube lecture URL → session builds (~1-2 min, all local).
2. Watch; at a checkpoint the video pauses and the tutor asks aloud.
3. Answer with your voice. Correct → brief praise, resume. Wrong → the tutor
   cites exactly what you missed, re-explains with a new analogy, offers to
   replay the exact passage.
4. Try answering "explain me" or nonsense — the evidence-enforced evaluator
   won't be gamed.
5. End recap: score per checkpoint, recurring weak spots, one click to replay
   any moment.

