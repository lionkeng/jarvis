import { describe, expect, it } from "vitest";
import { IdleFeatureSource } from "./idle-features.js";

describe("IdleFeatureSource", () => {
  it("reuses analyser-shaped buffers across idle frames", () => {
    const source = new IdleFeatureSource(32);
    const first = source.sample(1);
    const second = source.sample(17);
    expect(second).toBe(first);
    expect(second.frequencyData).toBe(first.frequencyData);
    expect(second.waveformData).toBe(first.waveformData);
    expect(second.frequencyData).toHaveLength(32);
  });
});
