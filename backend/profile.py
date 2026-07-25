"""Profile — local, append-only JSONL (SPEC §2.6). Never leaves disk."""

import json
import os
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SOCRATIC_DATA_DIR", ROOT / "data"))
PROFILE_PATH = DATA_DIR / "profile.jsonl"
SETTINGS_PATH = DATA_DIR / "settings.json"


def append(entry: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"ts": datetime.now().isoformat(timespec="seconds"), **entry}
    with open(PROFILE_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_all() -> list[dict]:
    if not PROFILE_PATH.exists():
        return []
    entries = []
    for line in PROFILE_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def save_settings(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def profile_summary(n: int = 5) -> str:
    """Context string for the re-explainer: self-declared background + last N misses."""
    parts = []
    background = load_settings().get("background", "").strip()
    if background:
        parts.append(f"Learner background: {background}")
    misses = [e for e in read_all() if e.get("verdict") in ("miss", "partial")][-n:]
    points = [p for e in misses for p in e.get("missed", [])]
    if points:
        parts.append("Recently missed points: " + "; ".join(points[-8:]))
    return "\n".join(parts)


def weak_spots(top: int = 5) -> list[dict]:
    """Missed points aggregated across all sessions (for the recap: 'twice now')."""
    counts = Counter(p for e in read_all() for p in e.get("missed", []))
    return [{"point": p, "count": c} for p, c in counts.most_common(top)]


def video_history(video_id: str) -> list[dict]:
    return [e for e in read_all() if e.get("video_id") == video_id]
