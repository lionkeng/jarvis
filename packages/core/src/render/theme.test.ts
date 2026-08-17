import { describe, expect, it } from "vitest";
import { resolveTheme, themeForFrame, themes } from "./theme.js";

describe("theme normalization", () => {
  it("merges partial themes and clamps numeric bounds", () => {
    expect(resolveTheme({ accent: "#123456", trailOpacity: 8 })).toMatchObject({ accent: "#123456", trailOpacity: 1, background: themes.cyan.background, textMotion: "flow" });
    expect(resolveTheme({ accent: "#123456" }).palette[0]).toBe("#123456");
    expect(resolveTheme({ trailOpacity: -1 }).trailOpacity).toBe(0.02);
    expect(resolveTheme({ textMotion: "kinetic" }).textMotion).toBe("kinetic");
    expect(resolveTheme({ density: 0, strokeWeight: 9, scale: 0 })).toMatchObject({ density: 0.25, strokeWeight: 3, scale: 0.5 });
  });

  it("supports deterministic cycle and state palettes", () => {
    const cycle = resolveTheme({ paletteMode: "cycle" });
    expect(themeForFrame(cycle, "idle", 0).accent).toBe(themes.cyan.accent);
    expect(themeForFrame(cycle, "idle", 15_001).accent).toBe(themes.amber.accent);
    expect(themeForFrame(cycle, "idle", 15_001).palette).toEqual(themes.amber.palette);
    const state = resolveTheme({ paletteMode: "state" });
    expect(themeForFrame(state, "thinking", 0).accent).toBe(themes.amber.accent);
    expect(themeForFrame(state, "interrupted", 0).accent).toBe(themes.rose.accent);
  });
});
