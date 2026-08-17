import type { VoiceFeatures, VoiceFeatureSource } from "./types.js";

export class IdleFeatureSource implements VoiceFeatureSource {
  readonly #features: VoiceFeatures;

  constructor(bins = 128) {
    this.#features = {
      level: 0,
      onset: 0,
      silenceMs: 0,
      centroid: 0.18,
      voiced: false,
      frequencyData: new Uint8Array(bins),
      waveformData: new Uint8Array(bins * 2),
    };
  }

  sample(now: number): VoiceFeatures {
    const phase = now / 1_000;
    const breath = 0.025 + (Math.sin(phase * 1.35) + 1) * 0.012;
    const { frequencyData, waveformData } = this.#features;
    for (let index = 0; index < frequencyData.length; index += 1) {
      frequencyData[index] = Math.round(Math.max(0, breath * 255 * Math.exp(-index / 32) + Math.sin(phase * 2 + index * 0.15) * 2));
    }
    for (let index = 0; index < waveformData.length; index += 1) {
      waveformData[index] = Math.round(128 + Math.sin(index * 0.08 + phase * 0.8) * breath * 40);
    }
    this.#features.level = breath;
    this.#features.silenceMs = Math.max(0, now);
    return this.#features;
  }

  dispose(): void {}
}

export function createIdleFeatures(now: number, bins = 128): VoiceFeatures {
  return new IdleFeatureSource(bins).sample(now);
}
