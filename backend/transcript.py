"""Transcript fetch + normalize (SPEC §2.1).

Primary: youtube-transcript-api. Fallback: yt-dlp audio → whisper.cpp (slower).
"""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import httpx

from backend.schemas import TranscriptLine

_ID_PATTERNS = [
    r"youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/)([A-Za-z0-9_-]{11})",
    r"youtu\.be/([A-Za-z0-9_-]{11})",
]

PREFERRED_LANGS = ["en", "fr", "es", "de", "it", "pt", "nl"]


def extract_video_id(url: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    for pat in _ID_PATTERNS:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    raise ValueError(f"cannot extract a YouTube video id from: {url!r}")


def fetch_title(video_id: str) -> str:
    try:
        r = httpx.get(
            "https://www.youtube.com/oembed",
            params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("title", "")
    except Exception:
        return ""


def _normalize(raw: list[dict]) -> list[TranscriptLine]:
    lines = []
    for x in raw:
        text = str(x["text"]).replace("\n", " ").strip()
        if text and not text.startswith("["):  # drop [Music], [Applause]…
            lines.append(TranscriptLine(t=float(x["start"]), text=text))
    return lines


def fetch_transcript_api(video_id: str) -> list[TranscriptLine]:
    from youtube_transcript_api import YouTubeTranscriptApi

    try:  # youtube-transcript-api >= 1.0
        api = YouTubeTranscriptApi()
        try:
            fetched = api.fetch(video_id, languages=PREFERRED_LANGS)
        except Exception:
            fetched = next(iter(api.list(video_id))).fetch()
        raw = fetched.to_raw_data()
    except AttributeError:  # < 1.0
        try:
            raw = YouTubeTranscriptApi.get_transcript(video_id, languages=PREFERRED_LANGS)
        except Exception:
            tl = next(iter(YouTubeTranscriptApi.list_transcripts(video_id)))
            raw = tl.fetch()
    return _normalize(raw)


def whisper_fallback(url: str, log=print) -> list[TranscriptLine]:
    """yt-dlp audio → whisper.cpp with timestamps. Slow path (SPEC §5: warn user)."""
    whisper_bin = os.environ.get("WHISPER_CPP_BIN", "whisper-cli")
    model = os.environ.get("WHISPER_CPP_MODEL")
    if not model:
        raise RuntimeError(
            "no YouTube transcript available and WHISPER_CPP_MODEL is not set "
            "(point it to e.g. ggml-medium.bin to enable the whisper fallback)"
        )
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "audio.wav"
        log("[transcript] downloading audio (yt-dlp)…")
        subprocess.run(
            [
                "yt-dlp", "-x", "--audio-format", "wav",
                "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
                "-o", str(Path(td) / "audio.%(ext)s"), url,
            ],
            check=True, capture_output=True,
        )
        log("[transcript] transcribing with whisper.cpp — this can take minutes…")
        out_base = Path(td) / "audio"
        subprocess.run(
            [whisper_bin, "-m", model, "-f", str(wav), "-l", "auto", "-np",
             "-oj", "-of", str(out_base)],
            check=True, capture_output=True,
        )
        data = json.loads((Path(td) / "audio.json").read_text())
        lines = []
        for seg in data.get("transcription", []):
            text = seg.get("text", "").strip()
            if text:
                lines.append(TranscriptLine(t=seg["offsets"]["from"] / 1000.0, text=text))
        return lines


def get_transcript(url: str, log=print) -> tuple[str, str, list[TranscriptLine]]:
    """Returns (video_id, title, transcript). Raises if both paths fail."""
    video_id = extract_video_id(url)
    title = fetch_title(video_id)
    try:
        lines = fetch_transcript_api(video_id)
    except Exception as e:
        log(f"[transcript] youtube-transcript-api failed ({e}); trying whisper fallback")
        lines = whisper_fallback(url, log=log)
    if not lines:
        raise RuntimeError("empty transcript")
    return video_id, title, lines
