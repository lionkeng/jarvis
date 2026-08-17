import type { VoiceFeatures } from "../../audio/types.js";
import type { AgentState } from "../../state/types.js";

export interface KineticTransform {
  x: number;
  y: number;
  rotation: number;
  tracking: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  glow: number;
}

const still: KineticTransform = {
  x: 0,
  y: 0,
  rotation: 0,
  tracking: 0,
  scaleX: 1,
  scaleY: 1,
  alpha: 1,
  glow: 0,
};

export function kineticTransform(
  tokenIndex: number,
  tokenCount: number,
  lineIndex: number,
  features: VoiceFeatures,
  state: AgentState,
  now: number,
  reducedMotion = false,
): KineticTransform {
  if (reducedMotion) return still;
  const position = tokenCount <= 1 ? 0 : tokenIndex / (tokenCount - 1) * 2 - 1;
  const phase = now * 0.0032 + tokenIndex * 0.83 + lineIndex * 0.31;
  const stateForce = state === "speaking" ? 1 : state === "thinking" ? 0.32 : state === "interrupted" ? -0.42 : 0.08;
  const energy = Math.min(1.4, features.level * 0.72 + features.onset * 1.25 + (features.voiced ? 0.24 : 0));
  const spread = stateForce * energy * (8 + Math.abs(position) * 7);
  const bounce = state === "speaking" ? -features.onset * (9 + (tokenIndex % 3) * 3) : 0;
  const release = state === "interrupted" ? 7 + Math.abs(position) * 9 : 0;
  const shimmer = features.centroid * Math.sin(phase * 2.3) * 2.4;
  const split = position * spread;

  return {
    x: split + Math.sin(phase * 0.7) * energy * 2.2,
    y: bounce + release + Math.cos(phase) * energy * 2.6,
    rotation: position * stateForce * energy * 3.2 + Math.sin(phase * 1.3) * energy * 1.1,
    tracking: Math.max(-0.5, split * 0.04 + features.centroid * stateForce),
    scaleX: Math.max(0.9, 1 + Math.abs(stateForce) * features.onset * 0.08 + Math.abs(position) * energy * 0.018),
    scaleY: Math.max(0.88, 1 + stateForce * features.level * 0.055 - features.onset * 0.025),
    alpha: state === "interrupted" ? 0.72 : 1,
    glow: Math.max(0, (features.onset * 10 + features.centroid * 5) * Math.max(0, stateForce) + shimmer),
  };
}
