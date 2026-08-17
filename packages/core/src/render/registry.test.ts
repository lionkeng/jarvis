import { describe, expect, it } from "vitest";
import { PresetRegistry } from "./registry.js";

describe("PresetRegistry", () => {
  it("returns stable layer order regardless of selection order", () => {
    expect(new PresetRegistry().create(["hud", "ring", "bars"]).map(({ name }) => name)).toEqual(["bars", "ring", "hud"]);
  });

  it("rejects unknown preset names", () => {
    expect(() => new PresetRegistry().create(["missing" as "ring"])).toThrow("Unknown visualization preset");
  });
});
