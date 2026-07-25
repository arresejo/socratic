import React from "react";
import {
  AbsoluteFill,
  Series,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
} from "remotion";
import { CLIPS, FPS, TITLE_SECONDS, END_SECONDS, CAPTION_SECONDS } from "./config";
import { Glyph, BG, FONT } from "./theme";

const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  const line1 = interpolate(frame, [20, 40], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  const line2 = interpolate(frame, [45, 65], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  const out = interpolate(frame, [TITLE_SECONDS * FPS - 15, TITLE_SECONDS * FPS], [1, 0], {
    extrapolateLeft: "clamp",
  });
  return (
    <AbsoluteFill
      style={{ background: BG, alignItems: "center", justifyContent: "center", fontFamily: FONT, opacity: out }}
    >
      <div style={{ transform: `scale(${pop})` }}>
        <Glyph size={150} />
      </div>
      <h1 style={{ color: "#fff", fontSize: 84, fontWeight: 700, margin: "40px 0 0", opacity: line1 }}>
        Socratic
      </h1>
      <p style={{ color: "#aab", fontSize: 40, marginTop: 18, opacity: line2 }}>
        You don't watch the video anymore. The video quizzes you.
      </p>
    </AbsoluteFill>
  );
};

const Clip: React.FC<{ file: string; caption: string; start: number; rate: number }> = ({
  file,
  caption,
  start,
  rate,
}) => {
  const frame = useCurrentFrame();
  const capIn = interpolate(frame, [8, 22], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  const capOut = interpolate(
    frame,
    [CAPTION_SECONDS * FPS, CAPTION_SECONDS * FPS + 18],
    [1, 0],
    { extrapolateRight: "clamp", extrapolateLeft: "clamp" }
  );
  const capOpacity = capIn * capOut;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <OffthreadVideo
        src={staticFile(`clips/${file}`)}
        startFrom={Math.round(start * FPS)}
        playbackRate={rate}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 48,
          left: "50%",
          transform: "translateX(-50%)",
          maxWidth: 1400,
          background: "rgba(11,14,36,.85)",
          border: "1px solid rgba(255,255,255,.12)",
          borderRadius: 16,
          padding: "18px 36px",
          color: "#f1f1f1",
          fontFamily: FONT,
          fontSize: 34,
          fontWeight: 500,
          textAlign: "center",
          opacity: capOpacity,
          backdropFilter: "blur(8px)",
        }}
      >
        {caption}
      </div>
    </AbsoluteFill>
  );
};

const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  const fade = interpolate(frame, [15, 35], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  return (
    <AbsoluteFill
      style={{ background: BG, alignItems: "center", justifyContent: "center", fontFamily: FONT }}
    >
      <div style={{ transform: `scale(${pop})` }}>
        <Glyph size={120} />
      </div>
      <h2 style={{ color: "#fff", fontSize: 56, fontWeight: 700, margin: "36px 0 0", opacity: fade }}>
        All on-device. Gemma 4.
      </h2>
      <p style={{ color: "#6fdc8c", fontSize: 34, marginTop: 16, opacity: fade }}>
        🔒 Your map of ignorance never leaves your machine.
      </p>
      <p style={{ color: "#aab", fontSize: 30, marginTop: 26, opacity: fade }}>
        github.com/arresejo/socratic
      </p>
    </AbsoluteFill>
  );
};

export const Demo: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={TITLE_SECONDS * FPS}>
      <TitleCard />
    </Series.Sequence>
    {CLIPS.map((c) => (
      <Series.Sequence key={c.file} durationInFrames={Math.round(c.seconds * FPS)}>
        <Clip file={c.file} caption={c.caption} start={c.start} rate={c.rate} />
      </Series.Sequence>
    ))}
    <Series.Sequence durationInFrames={END_SECONDS * FPS}>
      <EndCard />
    </Series.Sequence>
  </Series>
);
