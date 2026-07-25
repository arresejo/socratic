"""Evaluator — rubric-per-key-point grading with evidence quotes (SPEC §2.4)."""

import re

from backend.llm import chat_json
from backend.schemas import Checkpoint, Evaluation, Session

SYSTEM_PROMPT = """You evaluate a learner's spoken answer to a comprehension question.

You receive the source passage (ground truth), the question, the expected key
points, typical mistakes, and the learner's transcribed answer (oral style:
ignore fillers, hesitations, grammar — judge CONTENT only).

For EACH expected key point, output: "covered" | "partial" | "missed",
with evidence: a VERBATIM quote from the learner's answer when covered/partial.
Never quote the source passage as evidence — only the learner's own words.
An answer that does not address the question (e.g. "explain", "I don't know",
a question back) means every key point is "missed".
Check whether any typical mistake appears in the answer.
Benefit of the doubt goes to "partial", never to a harsh "missed".

verdict: "pass" (all covered or one partial) | "partial" (some missing)
| "miss" (core misunderstood or mistake detected)
feedback: 2 sentences MAX, spoken style, addressed to the learner, specific.
Write the feedback in the same language as the question.

Output ONLY JSON:
{"points": {"<key point>": {"status": "...", "evidence": "..."}},
 "mistakes_detected": [...], "verdict": "...", "feedback": "..."}
"""


def source_text(session: Session, cp: Checkpoint) -> str:
    lines = [
        l.text for l in session.transcript
        if cp.t_source_start - 2 <= l.t <= cp.t_source_end + 2
    ]
    return " ".join(lines)


def _validate(data) -> Evaluation:
    # Tolerate a list-shaped "points" ([{point, status, evidence}, ...])
    pts = data.get("points")
    if isinstance(pts, list):
        data["points"] = {
            p.get("point", p.get("key_point", f"point {i + 1}")): {
                "status": p.get("status", "missed"),
                "evidence": p.get("evidence", ""),
            }
            for i, p in enumerate(pts)
        }
    return Evaluation.model_validate(data)


def evaluate(
    source: str,
    question: str,
    expected_key_points: list[str],
    typical_mistakes: list[str],
    answer: str,
) -> Evaluation:
    user = (
        f"Source passage (ground truth):\n{source}\n\n"
        f"Question: {question}\n\n"
        "Expected key points:\n"
        + "\n".join(f"- {p}" for p in expected_key_points)
        + "\n\nTypical mistakes:\n"
        + ("\n".join(f"- {m}" for m in typical_mistakes) or "- (none)")
        + f"\n\nLearner's transcribed answer:\n{answer}"
    )
    # Fast path: no chain-of-thought (~5 s). Grading integrity is then enforced
    # by the evidence check: a point only counts if its quote actually comes
    # from the learner's answer. If the fast model fabricated evidence, escalate
    # to the slow thinking path (~15 s) — rare, and exactly the cases that
    # deserve the extra scrutiny (empty/gaming/ambiguous answers).
    result = chat_json(SYSTEM_PROMPT, user, _validate, temperature=0.1,
                       max_tokens=2048, think=False)
    if _enforce_evidence(result, answer):
        result = chat_json(SYSTEM_PROMPT, user, _validate, temperature=0.1,
                           max_tokens=2048, think=True)
        _enforce_evidence(result, answer)
    return result


_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def _tokens(s: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(s)]


def _evidence_in_answer(evidence: str, answer: str) -> bool:
    ev = _tokens(evidence)
    if not ev:
        return False
    ans = _tokens(answer)
    if " ".join(ev) in " ".join(ans):
        return True
    ans_set = set(ans)  # tolerate STT drift / partial quoting
    return sum(1 for t in ev if t in ans_set) / len(ev) >= 0.7


def _enforce_evidence(result: Evaluation, answer: str) -> bool:
    """Downgrade points whose evidence is not actually from the learner's
    answer; recompute the verdict (never upwards). Returns True if anything
    was downgraded — i.e. the model fabricated evidence."""
    downgraded = False
    for pe in result.points.values():
        if pe.status in ("covered", "partial") and not _evidence_in_answer(pe.evidence, answer):
            pe.status = "missed"
            pe.evidence = ""
            downgraded = True
    if downgraded:
        statuses = [pe.status for pe in result.points.values()]
        if all(s == "missed" for s in statuses):
            new = "miss"
        elif statuses.count("missed") == 0 and statuses.count("partial") <= 1:
            new = "pass"
        else:
            new = "partial"
        rank = {"pass": 0, "partial": 1, "miss": 2}
        if rank[new] > rank[result.verdict]:
            result.verdict = new
    return downgraded
