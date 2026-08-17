import { describe, expect, it } from "vitest";
import { computeRegions } from "./regions.js";

describe("computeRegions", () => {
  it.each([[320, 640], [800, 600], [1440, 900]])("keeps regions in bounds at %sx%s", (width, height) => {
    const regions = computeRegions(width, height);
    for (const rect of [regions.viz, regions.panel]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    }
  });

  it("moves the panel to the bottom on a narrow host", () => {
    expect(computeRegions(360, 720).placement).toBe("bottom");
    expect(computeRegions(900, 520).placement).toBe("side");
  });

  it("honors forced placement", () => {
    expect(computeRegions(900, 520, { placement: "bottom" }).placement).toBe("bottom");
    expect(computeRegions(360, 720, { placement: "side" }).placement).toBe("side");
  });

  it.each([[0, 0], [1, 1], [24, 12]])("never returns negative regions for a %sx%s host", (width, height) => {
    const regions = computeRegions(width, height);
    for (const rect of [regions.viz, regions.panel]) {
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    }
  });
});
