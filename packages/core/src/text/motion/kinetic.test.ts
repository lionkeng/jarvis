import { describe, expect, it } from "vitest";
import { createIdleFeatures } from "../../audio/idle-features.js";
import { kineticTransform } from "./kinetic.js";

describe("kineticTransform", () => {
  it("provides speech-driven split/bounce/glow and a yielding interrupted state", () => {
    const features = { ...createIdleFeatures(0), level: 0.8, onset: 0.7, centroid: 0.6, voiced: true };
    const speaking = kineticTransform(3, 8, 1, features, "speaking", 1_000);
    const interrupted = kineticTransform(3, 8, 1, features, "interrupted", 1_000);
    expect(Math.abs(speaking.x)).toBeGreaterThan(1);
    expect(speaking.y).toBeLessThan(0);
    expect(speaking.glow).toBeGreaterThan(0);
    expect(interrupted.alpha).toBeLessThan(1);
    expect(interrupted.y).toBeGreaterThan(speaking.y);
  });

  it("removes all kinetic movement for reduced motion", () => {
    const transform = kineticTransform(2, 4, 0, createIdleFeatures(0), "speaking", 1_000, true);
    expect(transform).toMatchObject({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, glow: 0 });
  });
});
