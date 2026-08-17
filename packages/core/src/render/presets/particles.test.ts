import { describe, expect, it, vi } from "vitest";
import { createIdleFeatures } from "../../audio/idle-features.js";
import { computeRegions } from "../../layout/regions.js";
import { themes } from "../theme.js";
import { ParticlePreset } from "./particles.js";

describe("ParticlePreset", () => {
  it("spawns speech-onset particles as clipped circular marks and clears private state", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const context = {
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: "", globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const preset = new ParticlePreset();
    const regions = computeRegions(320, 200, { inset: 0 });
    const features = { ...createIdleFeatures(0), level: 0.7, onset: 0.9, centroid: 0.5 };
    preset.paint({ context, width: 320, height: 200, pixelRatio: 1, now: 1, deltaSeconds: 1 / 60, state: "speaking", stateAge: 0.2, features, regions, theme: themes.cyan, reducedMotion: false });
    expect(context.arc).toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();

    preset.dispose();
    vi.mocked(context.arc).mockClear();
    preset.paint({ context, width: 320, height: 200, pixelRatio: 1, now: 2, deltaSeconds: 1 / 60, state: "idle", stateAge: 0, features: createIdleFeatures(2), regions, theme: themes.cyan, reducedMotion: true });
    expect(context.arc).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
