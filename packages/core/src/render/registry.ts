import type { PresetName, VisualizationPreset } from "./types.js";
import { barsPreset, hudPreset, ParticlePreset, ringPreset, waveformPreset } from "./presets/index.js";

type PresetFactory = () => VisualizationPreset;

export class PresetRegistry {
  #factories = new Map<string, PresetFactory>();

  constructor() {
    this.register("bars", () => barsPreset);
    this.register("waveform", () => waveformPreset);
    this.register("ring", () => ringPreset);
    this.register("particles", () => new ParticlePreset());
    this.register("hud", () => hudPreset);
  }

  register(name: string, factory: PresetFactory): void {
    this.#factories.set(name, factory);
  }

  create(names: readonly PresetName[]): VisualizationPreset[] {
    return names.map((name) => {
      const factory = this.#factories.get(name);
      if (!factory) throw new Error(`Unknown visualization preset: ${name}`);
      return factory();
    }).sort((left, right) => left.layer - right.layer);
  }
}
