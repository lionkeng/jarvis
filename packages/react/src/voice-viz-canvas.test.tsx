// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEventListener, RealtimeToolResult, RealtimeTransport } from "@jarvis-viz/core";
import { VoiceVizCanvas } from "./voice-viz-canvas.js";

class FakeTransport implements RealtimeTransport {
  connected = false;
  agentAudio = null;
  disconnect = vi.fn(() => { this.connected = false; });
  async connect(): Promise<void> { this.connected = true; }
  subscribe(_listener: RealtimeEventListener): () => void { return vi.fn(); }
  submitToolResult = vi.fn((_result: RealtimeToolResult) => undefined);
}

describe("VoiceVizCanvas", () => {
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

  it("mounts one core instance and disposes it on React unmount", () => {
    const transport = new FakeTransport();
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<VoiceVizCanvas options={{ transport, reducedMotion: true }} />));
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    act(() => root.unmount());
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(host.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("updates mutable visualization options without remounting the core instance", () => {
    const transport = new FakeTransport();
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<VoiceVizCanvas options={{ transport, theme: "cyan", presets: ["ring"], reducedMotion: true }} />));
    const canvas = host.querySelector("canvas");
    act(() => root.render(<VoiceVizCanvas options={{ transport, theme: "amber", presets: ["ring", "hud"], panelPlacement: "side", reducedMotion: true }} />));
    expect(host.querySelector("canvas")).toBe(canvas);
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    expect(transport.disconnect).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });
});
