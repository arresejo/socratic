import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import { FPS, totalFrames } from "./config";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={totalFrames()}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
