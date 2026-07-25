"""Segmenter — THE quality-critical component (SPEC §2.2).

One offline LLM pass over the transcript in sliding windows (~9 min, 1 min
overlap). Everything is precomputed so pauses cost 0 ms at play time.
"""

import math

from pydantic import BaseModel, Field

from backend.llm import chat_json
from backend.schemas import Checkpoint, Session, TranscriptLine

WINDOW_S = 540   # ~9 min windows
STEP_S = 480     # → 60 s overlap
MIN_GAP_S = 90
MAX_PER_HOUR = 7
MIN_FIRST_PAUSE_S = 120  # hard guard: no checkpoint in the intro (SPEC §2.2)

SYSTEM_PROMPT = """You are preparing an active-recall session from a lecture transcript with timestamps.

Split the content into pedagogical units: ONE concept fully explained = one unit.
For each unit produce a checkpoint placed AFTER the explanation ends (never
mid-sentence, never mid-example).

Rules:
- 5 to 7 checkpoints per hour of video maximum. Minimum 90 seconds between checkpoints.
- Prefer conceptual questions ("why", "what happens if", "explain in your own words")
  over factual recall ("what year", "what is the name of").
- Phrase each question as ONE spoken sentence, conversational, addressed directly
  to the learner — it will be read aloud by a voice assistant. Never exam-style
  phrasing ("specifically defining…", "discuss…").
- The question must be answerable using ONLY what the speaker said BEFORE t_pause.
  Never ask about a mechanism the video announces it will explain later.
- The question must have exactly ONE natural interpretation. Avoid ambiguous
  verbs (e.g. "break down") and pronouns without a clear referent.
- NEVER mention any person's name unless it appears verbatim in the transcript.
  Refer to the speaker as "the video" or "he"/"she".
- expected_key_points: 2-3 items a correct answer MUST contain. Write them as
  content criteria, not quotes. Each key point must test exactly ONE idea —
  never bundle two concepts into one point.
- typical_mistakes: 1-3 plausible misunderstandings of THIS passage.
- t_source_start/end: the span where this concept is actually explained
  (used for replay and re-explanation). It must cover at least 30 seconds.
- Place t_pause at the TRUE END of the pedagogical unit: if the next sentence
  continues the same idea, the pause is too early — move it later.
- depth: how conceptual this unit is — 3 = core idea of the video, 2 = important
  mechanism, 1 = peripheral detail. Prefer producing depth-3 and depth-2 units.
- Skip intros, sponsor segments, recaps, and chit-chat entirely.
- Write concept, question, expected_key_points and typical_mistakes in the SAME
  LANGUAGE as the transcript.
- All timestamps must lie within the window you are given. If the window contains
  no complete pedagogical unit, output {"checkpoints": []}.

Output ONLY JSON of this exact form:
{"checkpoints": [{"t_pause": <float seconds>, "t_source_start": <float>,
  "t_source_end": <float>, "concept": "...", "question": "...",
  "expected_key_points": ["..."], "typical_mistakes": ["..."], "depth": <1-3>}]}
"""


class _Draft(BaseModel):
    t_pause: float
    t_source_start: float
    t_source_end: float
    concept: str
    question: str
    expected_key_points: list[str] = Field(min_length=1)
    typical_mistakes: list[str] = Field(default_factory=list)
    depth: int = Field(default=2, ge=1, le=3)


class _WindowOut(BaseModel):
    checkpoints: list[_Draft] = Field(default_factory=list)


VERIFY_SYSTEM = """You verify quiz rubric criteria against a source passage.

For each numbered criterion, decide whether a learner could satisfy it using
ONLY what this passage actually EXPLAINS. If the passage merely mentions the
topic without explaining it, or explicitly says it will be explained later,
the criterion is NOT supported.

Output ONLY JSON: {"supported": [true, false, ...]} — one boolean per
criterion, in the same order."""


class _VerifyOut(BaseModel):
    supported: list[bool]


def _validate_verify(data) -> _VerifyOut:
    if isinstance(data, list):
        data = {"supported": data}
    return _VerifyOut.model_validate(data)


def _validate_window(data) -> _WindowOut:
    if isinstance(data, list):
        data = {"checkpoints": data}
    return _WindowOut.model_validate(data)


def _format_lines(lines: list[TranscriptLine]) -> str:
    return "\n".join(f"[{l.t:.1f}] {l.text}" for l in lines)


def _self_check(checkpoints: list[Checkpoint], lines: list[TranscriptLine], log) -> list[Checkpoint]:
    """Second LLM pass: prune expected_key_points that the source span doesn't
    actually teach (the model sometimes writes criteria for content that is
    only announced). Fail open: on any error, keep the checkpoint as-is."""
    kept: list[Checkpoint] = []
    for cp in checkpoints:
        source = " ".join(
            l.text for l in lines
            if cp.t_source_start - 2 <= l.t <= cp.t_source_end + 2
        )
        user = (
            f"Passage:\n{source}\n\nCriteria:\n"
            + "\n".join(f"{i + 1}. {p}" for i, p in enumerate(cp.expected_key_points))
        )
        try:
            out = chat_json(VERIFY_SYSTEM, user, _validate_verify,
                            temperature=0.0, max_tokens=1024)
            if len(out.supported) != len(cp.expected_key_points):
                raise ValueError("length mismatch")
            pruned = [p for p, ok in zip(cp.expected_key_points, out.supported) if ok]
            dropped = [p for p, ok in zip(cp.expected_key_points, out.supported) if not ok]
            for p in dropped:
                log(f"[self-check] {cp.id}: pruned unsupported key point: {p[:80]}")
            if not pruned:
                log(f"[self-check] {cp.id}: DROPPED (no key point supported by the span)")
                continue
            cp.expected_key_points = pruned
        except Exception as e:  # noqa: BLE001 — fail open, never lose a session
            log(f"[self-check] {cp.id}: check failed ({e}) — kept as-is")
        kept.append(cp)
    for i, cp in enumerate(kept):  # re-number after potential drops
        cp.id = f"cp{i + 1}"
    return kept


def build_session(video_id: str, title: str, lines: list[TranscriptLine], log=print) -> Session:
    duration = lines[-1].t + 10.0
    drafts: list[_Draft] = []
    start = 0.0
    while start < duration:
        end = start + WINDOW_S
        wlines = [l for l in lines if start <= l.t < end]
        if sum(len(l.text) for l in wlines) > 200:
            user = (
                f"Video title: {title or video_id}\n"
                f"Transcript window from {start:.0f}s to {end:.0f}s:\n\n"
                + _format_lines(wlines)
            )
            try:
                out = chat_json(SYSTEM_PROMPT, user, _validate_window, think=True)
                drafts.extend(out.checkpoints)
                log(f"[segmenter] window {start:.0f}-{end:.0f}s: {len(out.checkpoints)} checkpoint(s)")
            except Exception as e:  # dropped after one retry — log, never crash (SPEC §5)
                log(f"[segmenter] window {start:.0f}-{end:.0f}s DROPPED: {e}")
        start += STEP_S
    checkpoints = _merge(drafts, duration)
    checkpoints = _self_check(checkpoints, lines, log)
    log(f"[segmenter] total: {len(checkpoints)} checkpoint(s) over {duration/60:.1f} min")
    return Session(video_id=video_id, title=title, checkpoints=checkpoints, transcript=lines)


def _merge(drafts: list[_Draft], duration: float) -> list[Checkpoint]:
    """Sort, sanitize timestamps, dedupe overlap-window twins, enforce the
    90 s gap; when over the 7/h cap, keep the most conceptual units (depth)."""
    valid = [d for d in drafts if MIN_FIRST_PAUSE_S <= d.t_pause <= duration]
    if not valid:  # degenerate: very short video, fall back to whatever exists
        valid = [d for d in drafts if 0 < d.t_pause <= duration]
    kept: list[_Draft] = []
    min_gap = 60.0 if duration < 360 else MIN_GAP_S  # adaptive: short videos
    for d in sorted(valid, key=lambda d: d.t_pause):
        d.t_source_end = min(d.t_source_end, d.t_pause)
        if d.t_source_start >= d.t_source_end:
            d.t_source_start = max(0.0, d.t_pause - 120.0)
        if d.t_source_end - d.t_source_start < 30.0:  # replay span ≥ 30 s
            d.t_source_start = max(0.0, d.t_source_end - 60.0)
        if kept and d.t_pause - kept[-1].t_pause < min_gap:
            prev = kept[-1]
            if d.depth > prev.depth:  # keep the deeper of the two twins
                kept[-1] = d
            continue
        kept.append(d)
    # Cap: 7/h pro-rata (SPEC), with a pragmatic floor for SHORT videos —
    # a dense 8-min explainer deserves ~3 questions, not ceil(0.13h*7)=1.
    # The adaptive gap remains the hard anti-spam limit.
    floor = min(3, int(duration // 150))  # 1 question per ~2.5 min, capped at 3
    max_cp = max(1, math.ceil(duration / 3600.0 * MAX_PER_HOUR), floor)
    if len(kept) > max_cp:
        # "Prefer the most conceptual units" (SPEC §5) with temporal coverage,
        # duration-agnostic: one time bucket per checkpoint slot, deepest unit
        # of each bucket wins (tie → the LATER one: syntheses live at the end).
        # Empty-bucket slots go to the deepest leftovers video-wide.
        buckets: list[list[_Draft]] = [[] for _ in range(max_cp)]
        for d in kept:
            buckets[min(max_cp - 1, int(d.t_pause / duration * max_cp))].append(d)
        for b in buckets:
            b.sort(key=lambda d: (-d.depth, -d.t_pause))
        picked = [b[0] for b in buckets if b]
        leftovers = sorted(
            (d for b in buckets for d in b[1:]),
            key=lambda d: (-d.depth, -d.t_pause),
        )
        picked += leftovers[: max_cp - len(picked)]
        kept = sorted(picked, key=lambda d: d.t_pause)
    return [
        Checkpoint(id=f"cp{i + 1}", **d.model_dump(exclude={"depth"}))
        for i, d in enumerate(kept)
    ]
