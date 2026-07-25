import React from "react";

/* Le glyphe Socratic (pause interrompue par une question), recolorable. */
export const Glyph: React.FC<{ size?: number; color?: string }> = ({
  size = 120,
  color = "#ffffff",
}) => (
  <svg
    viewBox="130 105 250 290"
    width={size}
    height={(size * 290) / 250}
    style={{ display: "block" }}
  >
    <rect x="162" y="135" width="50" height="230" rx="25" fill={color} />
    <path
      d="M 240 190 A 55 55 0 1 1 295 245 L 295 272"
      fill="none"
      stroke={color}
      strokeWidth="50"
      strokeLinecap="round"
    />
    <circle cx="295" cy="338" r="27" fill="#f5b942" />
  </svg>
);

export const BG = "linear-gradient(180deg, #1c2350 0%, #0b0e24 100%)";
export const FONT =
  '"Roboto", "YouTube Sans", -apple-system, BlinkMacSystemFont, sans-serif';
