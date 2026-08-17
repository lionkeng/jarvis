import type { VoiceFeatures } from "../audio/types.js";
import type { Regions } from "../layout/types.js";
import type { AgentState } from "../state/types.js";
import type { Theme } from "./theme.js";

export interface VizFrame {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  pixelRatio: number;
  now: number;
  deltaSeconds: number;
  state: AgentState;
  stateAge: number;
  features: VoiceFeatures;
  regions: Regions;
  theme: Theme;
  reducedMotion: boolean;
}

export interface VisualizationPreset {
  readonly name: string;
  readonly layer: number;
  paint(frame: VizFrame): void;
  dispose?(): void;
}

export type PresetName = "bars" | "waveform" | "ring" | "particles" | "hud";

export interface RendererFrameState {
  state: AgentState;
  stateAge: number;
  features: VoiceFeatures;
  regions: Regions;
  theme: Theme;
  reducedMotion: boolean;
  paintPanel?: (frame: VizFrame) => void;
}
