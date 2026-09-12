// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceViz } from "@jarvis-viz/core";
import { defineVoiceVizElement, VoiceVizElement } from "./voice-viz-element.js";

describe("VoiceVizElement", () => {
  beforeEach(() => {
    defineVoiceVizElement();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, arc() {}, fillText() {}, translate() {}, rotate() {},
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "", textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => vi.restoreAllMocks());

  it("mounts inside shadow DOM and removes its canvas on disconnect", () => {
    const element = document.createElement("jarvis-voice-viz");
    document.body.append(element);
    expect(element.shadowRoot?.querySelector("canvas")).not.toBeNull();
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain(":host");
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain("font: normal 16px/1.5");
    element.remove();
    expect(element.shadowRoot?.querySelector("canvas")).toBeNull();
  });

  it("lets hosts await session finalization", async () => {
    let finish!: () => void;
    const closing = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(VoiceViz.prototype, "disconnect").mockReturnValue(closing);
    const element = new VoiceVizElement();
    document.body.append(element);
    const done = element.disconnect();
    expect(done).toBeInstanceOf(Promise);
    let finalized = false;
    void Promise.resolve(done).then(() => { finalized = true; });
    await Promise.resolve();
    expect(finalized).toBe(false);
    finish();
    await done;
    expect(finalized).toBe(true);
    element.remove();
  });
});
