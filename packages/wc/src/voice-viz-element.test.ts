// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineVoiceVizElement } from "./voice-viz-element.js";

describe("VoiceVizElement", () => {
  beforeEach(() => {
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
    const tag = `jarvis-voice-viz-${Math.random().toString(36).slice(2)}`;
    defineVoiceVizElement(tag);
    const element = document.createElement(tag);
    document.body.append(element);
    expect(element.shadowRoot?.querySelector("canvas")).not.toBeNull();
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain(":host");
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain("font: normal 16px/1.5");
    element.remove();
    expect(element.shadowRoot?.querySelector("canvas")).toBeNull();
  });
});
