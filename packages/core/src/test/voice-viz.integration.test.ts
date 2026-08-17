// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceViz } from "../voice-viz.js";
import { createIdleFeatures } from "../audio/idle-features.js";
import type { VoiceFeatureSource } from "../audio/types.js";
import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeSessionPreferences, RealtimeTransport } from "../transport/types.js";

class FakeTransport implements RealtimeTransport {
  connected = false;
  agentAudio = null;
  listeners = new Set<RealtimeEventListener>();
  disconnect = vi.fn(() => { this.connected = false; this.emit({ type: "disconnected" }); });
  lastConnection: { endpoint: string; preferences: RealtimeSessionPreferences | undefined } | undefined;
  async connect(endpoint: string, preferences?: RealtimeSessionPreferences): Promise<void> {
    this.lastConnection = { endpoint, preferences };
    this.connected = true;
    this.emit({ type: "connected" });
  }
  subscribe(listener: RealtimeEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: NormalizedRealtimeEvent): void { for (const listener of this.listeners) listener(event); }
}

describe("VoiceViz integration", () => {
  let observerStarts = 0;
  let observerStops = 0;

  beforeEach(() => {
    observerStarts = 0;
    observerStops = 0;
    vi.stubGlobal("ResizeObserver", class {
      observe() { observerStarts += 1; }
      disconnect() { observerStops += 1; }
      unobserve() {}
    });
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => nextFrame++));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, arc() {}, fillText() {}, translate() {}, rotate() {}, scale() {}, measureText: (text: string) => ({ width: text.length * 8 }),
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "", textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 640, height: 480 } as DOMRect);
  });

  afterEach(() => vi.restoreAllMocks());

  it("maps transport events to state and transcript, then cleans up", async () => {
    const mount = document.createElement("div");
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(mount);
    viz.setTranscriptPace(1.15);
    await viz.connect("/session", { responseTiming: "fast", speechRate: 1.15 });
    expect(transport.lastConnection).toEqual({ endpoint: "/session", preferences: { responseTiming: "fast", speechRate: 1.15 } });
    transport.emit({ type: "user-speech-stopped" });
    transport.emit({ type: "agent-audio-started" });
    transport.emit({ type: "agent-text-delta", delta: "Hello " });
    transport.emit({ type: "agent-text-delta", delta: "there" });
    transport.emit({ type: "response-done" });
    expect(viz.state).toBe("idle");
    expect(viz.transcript.getSnapshot().messages[0]?.text).toBe("Hello there");
    viz.unmount();
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(transport.listeners.size).toBe(0);
    expect(mount.children).toHaveLength(0);
  });

  it("repeatedly mounts and unmounts without leaking RAF, observers, listeners, or feature sources", () => {
    const mount = document.createElement("div");
    const transports: FakeTransport[] = [];
    const featureSources: VoiceFeatureSource[] = [];
    const disposals: Array<ReturnType<typeof vi.fn>> = [];

    for (let index = 0; index < 4; index += 1) {
      const transport = new FakeTransport();
      const dispose = vi.fn();
      const featureSource: VoiceFeatureSource = { sample: (now) => createIdleFeatures(now), dispose };
      const viz = new VoiceViz({ transport, featureSource, reducedMotion: true });
      viz.mount(mount);
      transports.push(transport);
      featureSources.push(featureSource);
      disposals.push(dispose);
      expect(mount.querySelectorAll("canvas")).toHaveLength(1);
      viz.unmount();
      expect(mount.children).toHaveLength(0);
      expect(transport.listeners.size).toBe(0);
    }

    expect(featureSources).toHaveLength(4);
    expect(observerStarts).toBe(4);
    expect(observerStops).toBe(4);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(4);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(4);
    for (const transport of transports) expect(transport.disconnect).toHaveBeenCalledOnce();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  });

  it("records a final agent transcript even when the provider sends no deltas", () => {
    const mount = document.createElement("div");
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(mount);
    transport.emit({ type: "agent-text-done", text: "A complete provider transcript" });
    expect(viz.transcript.getSnapshot().messages.at(-1)).toMatchObject({
      role: "agent", text: "A complete provider transcript", status: "complete",
    });
    viz.unmount();
  });
});
