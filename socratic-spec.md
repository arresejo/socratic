# Socratic — the video that quizzes you back

> *Naming note: "Socratic" is a working title — the name is crowded in edtech (Google had a "Socratic" app; several "Socratic AI" products exist). Check availability before shipping; "Maieutic" (same root, rarer) is a candidate alternative.*

> **Local-first active-learning tutor for YouTube.** The video auto-pauses at key concepts, asks you a question out loud, listens to your spoken answer, grades it against the transcript, corrects you, and resumes. Passive watching becomes an interrogation — and your entire learning profile (what you get wrong, where you hesitate) never leaves your machine.

**Why local is constitutive, not cosmetic:** the system's core data is your *map of ignorance* — wrong answers, hesitations, knowledge gaps. Nobody wants that in a cloud. Local inference also makes unlimited questioning free (no per-token cost on hours of lectures).

**Market position (verified):** quiz-after-video tools exist (Recall, FlashRecall — passive, cloud, asynchronous); teacher-authored in-video questions exist (Edpuzzle — manual, classroom); auto-pause note-taking exists (Pauser — no dialogue, no evaluation, no voice, cloud). **Nobody does the full Socratic loop: auto-pause → generated question → spoken answer → graded feedback → targeted re-explanation → resume.** That loop is this project.

---

## 1. Architecture

```
[YouTube URL]
   → TRANSCRIPT FETCH   youtube-transcript-api (fallback: yt-dlp audio → whisper.cpp)
   → SEGMENTER          offline pass at load time (LLM): pedagogical units,
                        pause points, questions, expected key points   → session.json
   → PLAYER             YouTube iframe API + overlay UI
                        auto-pause at checkpoints (0ms latency: all precomputed)
   → VOICE LOOP         TTS asks question (Piper) → mic → VAD (silero) → STT (whisper.cpp)
   → EVALUATOR          LLM grades answer vs expected key points (structured rubric)
   → PEDAGOGICAL LOOP   pass → resume | partial → one targeted follow-up
                        | miss → re-explain differently + offer replay (seekTo)
   → PROFILE            append-only local JSON: concept, verdict, timestamp, video
```

All inference local. No network calls after transcript fetch.

### Tech stack

| Layer | Choice | Notes |
|---|---|---|
| LLM | **Gemma 4 26B A4B (MoE) instruct, Q4 GGUF** — target machine is a Mac mini M4 Pro / 64 GB unified memory, so the 26B fits easily (~16 GB). Served by `llama-server` (llama.cpp, Metal backend) on `localhost:8000`, OpenAI-compatible API. | The A4B MoE has only ~4B *active* params → big-model quality at small-model speed. Ideal: the segmenter (70% of product quality) gets the strongest model at no latency cost. Fallback/portable target: E4B (`ollama run gemma4:e4b`) — same API, swap via one env var. |
| STT | whisper.cpp, `medium` model (or `large-v3-turbo`) — the M4 Pro handles it easily; noticeably better on hesitant spoken answers than `small` | ~1-2s for short spoken answers |
| VAD | silero-vad | end-of-speech detection, no push-to-talk needed (but keep a mic button fallback) |
| TTS | Piper, one clear voice | streamable, <0.5s |
| Frontend | Single-page web app (React or vanilla), YouTube iframe API | **No browser extension in V1** |
| Backend | Python FastAPI: orchestrates segmenter/evaluator calls, serves session.json, writes profile | localhost only |

---

## 2. Component specs

### 2.1 Transcript fetch

- Input: YouTube URL. Use `youtube-transcript-api` → list of `{text, start, duration}`.
- If no transcript available: download audio via `yt-dlp`, run whisper.cpp with timestamps (slower path — show progress).
- Normalize into `transcript: [{t: float_seconds, text: str}]`.

### 2.2 Segmenter (offline pass — THE quality-critical component)

One LLM pass over the transcript (sliding windows of ~8–10 min with 1 min overlap), producing `session.json`. Everything is **precomputed**: at pause time nothing is generated, so the question appears instantly.

**Output schema (the contract everything else depends on):**

```json
{
  "video_id": "abc123",
  "title": "...",
  "checkpoints": [
    {
      "id": "cp1",
      "t_pause": 312.0,
      "t_source_start": 190.0,
      "t_source_end": 310.0,
      "concept": "Why AdamW over SGD for this architecture",
      "question": "In your own words, why does he prefer AdamW to plain SGD here?",
      "expected_key_points": [
        "adaptive per-parameter learning rates help with sparse gradients",
        "decoupled weight decay regularizes without distorting the adaptive step"
      ],
      "typical_mistakes": [
        "confusing weight decay with L2 in Adam",
        "claiming AdamW always generalizes better"
      ]
    }
  ]
}
```

**Segmenter system prompt (starting version — iterate on this more than on anything else):**

```
You are preparing an active-recall session from a lecture transcript with timestamps.

Split the content into pedagogical units: ONE concept fully explained = one unit.
For each unit produce a checkpoint placed AFTER the explanation ends (never
mid-sentence, never mid-example).

Rules:
- 5 to 7 checkpoints per hour of video maximum. Minimum 90 seconds between checkpoints.
- Prefer conceptual questions ("why", "what happens if", "explain in your own words")
  over factual recall ("what year", "what is the name of").
- expected_key_points: 2-3 items a correct answer MUST contain. Write them as
  content criteria, not quotes.
- typical_mistakes: 1-3 plausible misunderstandings of THIS passage.
- t_source_start/end: the span where this concept is actually explained
  (used for replay and re-explanation).
- Skip intros, sponsor segments, recaps, and chit-chat entirely.

Output ONLY the JSON matching the provided schema.
```

Validate output with pydantic; on invalid JSON, one retry with the error message; drop the window if it fails twice (log it).

### 2.3 Player + overlay

- YouTube iframe API: `pauseVideo()`, `playVideo()`, `seekTo(t)`, poll `getCurrentTime()` every 250ms.
- When `currentTime` crosses a `t_pause`: show a **3-second countdown badge** ("question in 3…2…1"), then pause + overlay.
- Overlay states: `question` (text shown + Piper reads it, mic opens) → `listening` (VAD active, live waveform) → `evaluating` (subtle "hmm…" from Piper covers the 3-4s) → `feedback` (verdict + spoken feedback) → auto-resume or branch.
- Always available: **Skip** button, **Type instead** input, intensity setting (light = 3 cp/h, normal = 5-7).

### 2.4 Evaluator

Called with: source segment text, question, expected_key_points, typical_mistakes, and the transcribed answer.

**Evaluator system prompt:**

```
You evaluate a learner's spoken answer to a comprehension question.

You receive the source passage (ground truth), the question, the expected key
points, typical mistakes, and the learner's transcribed answer (oral style:
ignore fillers, hesitations, grammar — judge CONTENT only).

For EACH expected key point, output: "covered" | "partial" | "missed",
with a short quote from the learner's answer as evidence when covered/partial.
Check whether any typical mistake appears in the answer.
Benefit of the doubt goes to "partial", never to a harsh "missed".

verdict: "pass" (all covered or one partial) | "partial" (some missing)
| "miss" (core misunderstood or mistake detected)
feedback: 2 sentences MAX, spoken style, addressed to the learner, specific.

Output ONLY JSON:
{"points": {"<key point>": {"status": "...", "evidence": "..."}},
 "mistakes_detected": [...], "verdict": "...", "feedback": "..."}
```

The rubric-per-key-point with evidence quotes is what makes grading stable and honest — never ask the model for a free-form "is this good?".

### 2.5 Pedagogical loop

- **pass** → Piper speaks feedback (1 sentence), auto-resume after 2s. Keep it fast.
- **partial** → ONE targeted follow-up on the single weakest point ("and what did he say about X?"). Second answer → evaluate → then correct + resume regardless (never loop more than once).
- **miss** → RE-EXPLAINER call: rewrite the source passage differently from the video (different angle/analogy; if profile shows the learner's background, calibrate to it). Then offer: "want to rewatch that part?" → `seekTo(t_source_start)`.

**Re-explainer prompt (small, separate call):**

```
The learner misunderstood this passage. Re-explain the concept in 3-5 sentences,
differently from the original wording, using a concrete analogy. Spoken style.
Learner context (may be empty): {profile_summary}
Passage: {source}. What they got wrong: {missed_points}.
```

### 2.6 Profile (local, append-only)

`profile.jsonl` — one line per interaction:

```json
{"ts": "2026-07-25T14:32:00", "video_id": "abc123", "concept": "...",
 "verdict": "partial", "missed": ["decoupled weight decay"], "checkpoint_id": "cp1"}
```

V1 uses it only to (a) build `profile_summary` for the re-explainer (last N misses, self-declared background from a one-line settings field) and (b) show a simple end-of-session recap ("You nailed 4/6. Weak spot: weight decay — twice now."). Spaced repetition is V2.

---

## 3. Repository structure

```
socratic/
├── SPEC.md                    ← this file
├── backend/
│   ├── main.py                # FastAPI: /session (build), /evaluate, /reexplain, /profile
│   ├── transcript.py          # fetch + normalize (+ whisper fallback)
│   ├── segmenter.py           # windowing, LLM call, pydantic validation
│   ├── evaluator.py
│   ├── reexplainer.py
│   ├── llm.py                 # thin OpenAI-compatible client → localhost:8000
│   ├── schemas.py             # pydantic models = the contracts above
│   └── profile.py
├── frontend/
│   ├── index.html
│   ├── app.js                 # iframe API, checkpoint watcher, overlay state machine
│   ├── voice.js               # mic, silero-vad (onnx web or via backend ws), waveform
│   └── styles.css
├── audio/
│   ├── stt.py                 # whisper.cpp wrapper (backend websocket endpoint)
│   └── tts.py                 # Piper wrapper, streams wav to frontend
└── scripts/
    └── serve_llm.sh           # llama-server -hf <gemma4-e4b Q4 GGUF> -c 8192 --port 8000
```

Data flow: frontend never talks to the LLM directly — everything goes through FastAPI (keeps prompts server-side, one place to log).

---

## 4. Milestones (build in this order)

1. **M1 — Session builder (CLI):** URL in → `session.json` out. Manually review question quality on the chosen demo candidates: **3Blue1Brown "But what is a neural network?"** (primary demo video), **Veritasium's entropy video** (general-audience fallback), plus one finance video (Ben Felix) as a domain test. Verify transcript availability with `youtube-transcript-api` for each BEFORE demo day. *Iterate the segmenter prompt until questions feel worth answering. This is 70% of product quality.*
2. **M2 — Player loop, text-only:** iframe + checkpoints + overlay; answers typed; evaluator wired; verdict shown. The product already works here.
3. **M3 — Voice:** Piper TTS out, mic + VAD + whisper in. Latency target: answer-end → spoken feedback ≤ 4s.
4. **M4 — Pedagogical branches:** follow-up, re-explainer, replay, profile + session recap.
5. **M5 — Polish:** countdown badge, intensity setting, skip/type fallbacks, session recap screen.

**Definition of done for V1 (the demo scenario):** load a real lecture → 3 checkpoints fire cleanly → answer one correctly (spoken), one deliberately wrong → the tutor catches the error, cites what was missing, re-explains differently, offers replay at the exact timestamp → end recap shows the profile. All offline (wifi can be cut after transcript fetch).

---

## 5. Edge cases & rules

- No transcript available → whisper fallback with progress UI; warn it takes minutes.
- Non-English video → keep everything in the video's language (Gemma 4 is multilingual); the UI follows.
- STT returns garbage/empty → "I didn't catch that, once more?" (one retry) → then offer keyboard.
- Invalid LLM JSON → one retry with error appended → skip gracefully, never crash the session.
- User seeks manually past checkpoints → mark skipped, don't fire retroactively.
- Very dense videos (>10 units/h) → keep the 7/h cap, prefer the most conceptual units.
- Privacy rule: **no network after transcript fetch**; profile and answers never leave disk.

## 6. Later (V2+) — out of scope now

Spaced repetition across sessions (profile is already the substrate) · browser extension · multimodal checkpoints on slides (E4B vision) · multi-video courses · the level-translator as a first-class mode (re-explain any passage at the user's level on demand).
