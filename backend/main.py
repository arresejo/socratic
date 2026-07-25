"""FastAPI orchestrator — localhost only (SPEC §1, §3).

The frontend never talks to the LLM directly: everything goes through here.
Run:  uvicorn backend.main:app --host 127.0.0.1 --port 8123
"""

import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from audio.stt import transcribe_audio
from audio.tts import synthesize
from backend import profile as profile_mod
from backend import transcript as transcript_mod
from backend.evaluator import evaluate, source_text
from backend.reexplainer import followup_question, reexplain
from backend.schemas import Session
from backend.segmenter import build_session

ROOT = Path(__file__).resolve().parent.parent
SESSIONS_DIR = profile_mod.DATA_DIR / "sessions"
TTS_CACHE_DIR = profile_mod.DATA_DIR / "tts_cache"


app = FastAPI(title="Socratic")

# The Chrome extension's content script calls this API from youtube.com.
# The server only ever binds localhost by default — CORS open is safe here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _session_path(video_id: str) -> Path:
    return SESSIONS_DIR / f"{video_id}.json"


def _load_session(video_id: str) -> Session:
    path = _session_path(video_id)
    if not path.exists():
        raise HTTPException(404, f"no session for video {video_id}")
    return Session.model_validate_json(path.read_text(encoding="utf-8"))


def _find_checkpoint(session: Session, checkpoint_id: str):
    for cp in session.checkpoints:
        if cp.id == checkpoint_id:
            return cp
    raise HTTPException(404, f"no checkpoint {checkpoint_id}")


# ---------- session ----------

class SessionRequest(BaseModel):
    url: str
    force: bool = False


@app.post("/api/session")
def create_session(req: SessionRequest) -> Session:
    try:
        video_id = transcript_mod.extract_video_id(req.url)
    except ValueError as e:
        raise HTTPException(422, f"URL YouTube invalide : {e}") from e
    path = _session_path(video_id)
    if path.exists() and not req.force:
        return Session.model_validate_json(path.read_text(encoding="utf-8"))
    try:
        video_id, title, lines = transcript_mod.get_transcript(req.url)
    except Exception as e:
        raise HTTPException(422, f"transcript unavailable: {e}") from e
    session = build_session(video_id, title, lines)
    if not session.checkpoints:
        raise HTTPException(500, "segmenter produced no checkpoints")
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(session.model_dump_json(indent=2), encoding="utf-8")
    _pregenerate_question_audio(session)  # best-effort, checkpoints speak instantly
    return session


def _question_wav_path(video_id: str, checkpoint_id: str) -> Path:
    return TTS_CACHE_DIR / video_id / f"{checkpoint_id}.wav"


def _pregenerate_question_audio(session: Session) -> None:
    """Questions are known at build time → synthesize their audio now so the
    checkpoint voice is instant at pause time. Best-effort: TTS may be down."""
    for cp in session.checkpoints:
        path = _question_wav_path(session.video_id, cp.id)
        if path.exists():
            continue
        try:
            wav = synthesize(cp.question)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(wav)
        except Exception:
            return  # no TTS backend — frontend falls back to on-the-fly/text


@app.get("/api/tts/question/{video_id}/{checkpoint_id}")
def tts_question(video_id: str, checkpoint_id: str):
    path = _question_wav_path(video_id, checkpoint_id)
    if not path.exists():
        session = _load_session(video_id)
        cp = _find_checkpoint(session, checkpoint_id)
        try:
            wav = synthesize(cp.question)
        except Exception as e:
            raise HTTPException(503, f"TTS unavailable: {e}") from e
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(wav)
    return Response(content=path.read_bytes(), media_type="audio/wav")


@app.get("/api/session/{video_id}")
def get_session(video_id: str) -> Session:
    return _load_session(video_id)


# ---------- evaluate / branches ----------

class EvaluateRequest(BaseModel):
    video_id: str
    checkpoint_id: str
    answer: str
    # Overrides for the follow-up turn (partial branch):
    question: Optional[str] = None
    expected_key_points: Optional[list[str]] = None
    is_followup: bool = False


@app.post("/api/evaluate")
def evaluate_answer(req: EvaluateRequest):
    session = _load_session(req.video_id)
    cp = _find_checkpoint(session, req.checkpoint_id)
    try:
        result = evaluate(
            source=source_text(session, cp),
            question=req.question or cp.question,
            expected_key_points=req.expected_key_points or cp.expected_key_points,
            typical_mistakes=cp.typical_mistakes,
            answer=req.answer,
        )
    except Exception as e:
        raise HTTPException(502, f"evaluator failed: {e}") from e
    if not req.is_followup:
        profile_mod.append({
            "video_id": req.video_id,
            "checkpoint_id": cp.id,
            "concept": cp.concept,
            "verdict": result.verdict,
            "missed": [p for p, ev in result.points.items() if ev.status != "covered"],
        })
    return result


class FollowupRequest(BaseModel):
    video_id: str
    checkpoint_id: str
    weak_point: str


@app.post("/api/followup")
def make_followup(req: FollowupRequest):
    session = _load_session(req.video_id)
    cp = _find_checkpoint(session, req.checkpoint_id)
    try:
        q = followup_question(source_text(session, cp), cp.question, req.weak_point)
    except Exception as e:
        raise HTTPException(502, f"follow-up generation failed: {e}") from e
    return {"question": q}


class ReexplainRequest(BaseModel):
    video_id: str
    checkpoint_id: str
    missed_points: list[str] = []


@app.post("/api/reexplain")
def make_reexplain(req: ReexplainRequest):
    session = _load_session(req.video_id)
    cp = _find_checkpoint(session, req.checkpoint_id)
    try:
        text = reexplain(source_text(session, cp), req.missed_points,
                         profile_mod.profile_summary())
    except Exception as e:
        raise HTTPException(502, f"re-explainer failed: {e}") from e
    return {"text": text, "t_source_start": cp.t_source_start}


# ---------- profile / settings / recap ----------

@app.post("/api/profile")
def profile_append(entry: dict):
    profile_mod.append(entry)
    return {"ok": True}


@app.get("/api/recap")
def recap(video_id: str):
    return {
        "history": profile_mod.video_history(video_id),
        "weak_spots": profile_mod.weak_spots(),
    }


@app.get("/api/stats")
def llm_stats():
    from backend.llm import STATS
    return STATS


class SettingsRequest(BaseModel):
    background: str = ""


@app.get("/api/settings")
def get_settings():
    return profile_mod.load_settings()


@app.post("/api/settings")
def set_settings(req: SettingsRequest):
    profile_mod.save_settings({"background": req.background})
    return {"ok": True}


# ---------- voice ----------

@app.post("/api/stt")
async def stt(audio: UploadFile = File(...)):
    data = await audio.read()
    suffix = Path(audio.filename or "answer.webm").suffix or ".webm"
    try:
        text = transcribe_audio(data, suffix=suffix)
    except Exception as e:
        raise HTTPException(503, f"STT unavailable: {e}") from e
    return {"text": text}


class TTSRequest(BaseModel):
    text: str


@app.post("/api/tts")
def tts(req: TTSRequest):
    try:
        wav = synthesize(req.text)
    except Exception as e:
        raise HTTPException(503, f"TTS unavailable: {e}") from e
    return Response(content=wav, media_type="audio/wav")


# ---------- frontend (mounted last) ----------

app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
