"""Pydantic models — the contracts everything else depends on (SPEC §2.2, §2.4)."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class TranscriptLine(BaseModel):
    t: float
    text: str


class Checkpoint(BaseModel):
    id: str
    t_pause: float
    t_source_start: float
    t_source_end: float
    concept: str
    question: str
    expected_key_points: list[str] = Field(min_length=1)
    typical_mistakes: list[str] = Field(default_factory=list)


class Session(BaseModel):
    video_id: str
    title: str = ""
    checkpoints: list[Checkpoint] = Field(default_factory=list)
    # Stored alongside the spec schema so the evaluator can slice source passages
    # without refetching anything (privacy rule: no network after transcript fetch).
    transcript: list[TranscriptLine] = Field(default_factory=list)


class PointEval(BaseModel):
    status: Literal["covered", "partial", "missed"]
    evidence: str = ""

    @field_validator("evidence", mode="before")
    @classmethod
    def _none_to_empty(cls, v):
        # The LLM often emits "evidence": null for missed points.
        return "" if v is None else v


class Evaluation(BaseModel):
    points: dict[str, PointEval] = Field(default_factory=dict)
    mistakes_detected: list[str] = Field(default_factory=list)
    verdict: Literal["pass", "partial", "miss"]
    feedback: str
