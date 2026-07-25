"""M1 — Session builder CLI: URL in → session.json out (SPEC §4).

    python -m backend.cli "https://www.youtube.com/watch?v=aircAruvnKk"
"""

import argparse
from pathlib import Path

from backend import profile as profile_mod
from backend.segmenter import build_session
from backend.transcript import get_transcript


def main() -> None:
    ap = argparse.ArgumentParser(description="Build session.json from a YouTube URL")
    ap.add_argument("url")
    ap.add_argument("-o", "--out", help="output path (default: data/sessions/<id>.json)")
    args = ap.parse_args()

    video_id, title, lines = get_transcript(args.url)
    print(f"Transcript: {len(lines)} lines, {lines[-1].t / 60:.1f} min — {title or video_id!r}")

    session = build_session(video_id, title, lines)

    out = Path(args.out) if args.out else profile_mod.DATA_DIR / "sessions" / f"{video_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(session.model_dump_json(indent=2), encoding="utf-8")
    print(f"\nWrote {out} ({len(session.checkpoints)} checkpoints)\n")

    for cp in session.checkpoints:
        print(f"— {cp.id} @ {cp.t_pause:.0f}s  [{cp.t_source_start:.0f}-{cp.t_source_end:.0f}]")
        print(f"  concept:  {cp.concept}")
        print(f"  question: {cp.question}")
        for p in cp.expected_key_points:
            print(f"    ✓ {p}")
        for m in cp.typical_mistakes:
            print(f"    ✗ {m}")
        print()


if __name__ == "__main__":
    main()
