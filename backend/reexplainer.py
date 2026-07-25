"""Re-explainer + follow-up question generation (SPEC §2.5)."""

from backend.llm import chat, plain_text

REEXPLAIN_SYSTEM = (
    "You are a patient tutor. Spoken style. Answer in the same language as the "
    "passage. Output only the re-explanation text, nothing else. "
    "Plain text only — never use markdown, asterisks or bullet points."
)

FOLLOWUP_SYSTEM = (
    "You write ONE short follow-up question for a live tutoring session. "
    "Spoken style, same language as the original question. "
    "Output only the question, nothing else. Plain text — no markdown."
)


def reexplain(source: str, missed_points: list[str], profile_summary: str = "") -> str:
    user = (
        "The learner misunderstood this passage. Re-explain the concept in 3-5 "
        "sentences, differently from the original wording, using a concrete "
        "analogy. Spoken style.\n"
        f"Learner context (may be empty): {profile_summary}\n"
        f"Passage: {source}\n"
        f"What they got wrong: {'; '.join(missed_points) or 'the core idea'}"
    )
    return plain_text(chat(REEXPLAIN_SYSTEM, user, temperature=0.6, max_tokens=2048))


def followup_question(source: str, question: str, weak_point: str) -> str:
    user = (
        f"Original question: {question}\n"
        f"The learner answered partially but missed this specific point: {weak_point}\n"
        f"Source passage: {source}\n\n"
        'Ask ONE short targeted follow-up probing exactly that point, in the '
        'style of: "and what did he say about X?"'
    )
    return plain_text(chat(FOLLOWUP_SYSTEM, user, temperature=0.4, max_tokens=1024)).strip('"')
