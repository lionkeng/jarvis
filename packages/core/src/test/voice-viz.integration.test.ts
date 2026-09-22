// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceViz } from "../voice-viz.js";
import { createIdleFeatures } from "../audio/idle-features.js";
import type { VoiceFeatureSource } from "../audio/types.js";
import type { AgentState } from "../state/types.js";
import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeSessionPreferences, RealtimeToolCall, RealtimeToolResult, RealtimeTransport } from "../transport/types.js";

class FakeTransport implements RealtimeTransport {
  connected = false;
  agentAudio = null;
  listeners = new Set<RealtimeEventListener>();
  disconnect = vi.fn(() => { this.connected = false; this.emit({ type: "disconnected" }); });
  lastConnection: { endpoint: string; preferences: RealtimeSessionPreferences | undefined } | undefined;
  connectHook: (() => Promise<void>) | undefined;
  async connect(endpoint: string, preferences?: RealtimeSessionPreferences): Promise<void> {
    this.lastConnection = { endpoint, preferences };
    if (this.connectHook) return this.connectHook();
    this.connected = true;
    this.emit({ type: "connected" });
  }
  subscribe(listener: RealtimeEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  submitToolResult = vi.fn((_result: RealtimeToolResult) => undefined);
  emit(event: NormalizedRealtimeEvent): void { for (const listener of this.listeners) listener(event); }
}

const grant = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } };

function stubLiveWire(ready: string) {
  const steps: string[] = [];
  const channel = { readyState: "connecting", send: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };
  const track = { stop: vi.fn() };
  class Peer {
    connectionState = "new";
    iceGatheringState = "complete";
    localDescription = { type: "offer", sdp: "v=0\r\nwith-ice" };
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    addTrack = vi.fn();
    close = vi.fn();
    createDataChannel = vi.fn(() => channel);
    createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0" }));
    setLocalDescription = vi.fn();
    setRemoteDescription = vi.fn(async () => { channel.readyState = "open"; });
    constructor() { steps.push("peer"); }
  }
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
  const fetcher = vi.fn(async (_input: unknown, init: RequestInit | undefined) => {
    if (init?.method !== "GET") {
      steps.push("grant");
      return Response.json(grant, { status: 201 });
    }
    steps.push("lease");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${ready}\n\n`)); },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { steps, fetcher, track };
}

/** Agent playback whose analyser byte data follows a caller-controlled amplitude. */
function stubAgentAudio() {
  let amplitude = 0;
  const analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    frequencyBinCount: 1024,
    connect() {}, disconnect() {},
    getByteTimeDomainData(target: Uint8Array) { target.fill(128 + amplitude); },
    // Bins 4 to 153 carry the 85 Hz - 3.6 kHz voice band at 48 kHz over 1024 bins.
    getByteFrequencyData(target: Uint8Array) { target.fill(0); target.fill(amplitude ? 200 : 0, 4, 154); },
  };
  vi.stubGlobal("AudioContext", class {
    state = "running";
    sampleRate = 48_000;
    destination = {};
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() {}
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockReturnValue(undefined);
  return { speak() { amplitude = 64; }, cut() { amplitude = 0; } };
}

describe("VoiceViz integration", () => {
  let observerStarts = 0;
  let observerStops = 0;
  let frame: FrameRequestCallback | undefined;

  beforeEach(() => {
    observerStarts = 0;
    observerStops = 0;
    frame = undefined;
    vi.stubGlobal("ResizeObserver", class {
      observe() { observerStarts += 1; }
      disconnect() { observerStops += 1; }
      unobserve() {}
    });
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return nextFrame++; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, arc() {}, fillText() {}, translate() {}, rotate() {}, scale() {}, measureText: (text: string) => ({ width: text.length * 8 }),
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "", textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 640, height: 480 } as DOMRect);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("leases the broker plan before any peer connection when the host supplies no transport", async () => {
    const live = stubLiveWire('{"protocols":["openai-live"]}');
    const viz = new VoiceViz({ reducedMotion: true });
    viz.mount(document.createElement("div"));
    const connecting = viz.connect("/session", { responseTiming: "fast", speechRate: 1.15 });
    const cancelled = expect(connecting).rejects.toThrow("cancelled");

    await vi.waitFor(() => expect(live.steps).toEqual(["lease", "peer", "grant"]));

    expect(live.fetcher).toHaveBeenNthCalledWith(1, "/session", expect.objectContaining({
      method: "GET", headers: { Accept: "text/event-stream" }, cache: "no-store", credentials: "omit",
    }));
    expect(JSON.parse(String(live.fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      protocol: "openai-live", responseTiming: "fast", speechRate: 1.15, sdp: "v=0\r\nwith-ice",
    });

    await viz.disconnect();
    await cancelled;

    expect(live.track.stop).toHaveBeenCalledOnce();
    expect(viz.connected).toBe(false);
    viz.unmount();
  });

  it("preserves overlapping Live captions without interrupting speech or completing a turn", async () => {
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    transport.emit({ type: "agent-audio-started" });
    transport.emit({ type: "live-caption", role: "agent", delta: "Hello", startMs: 0, endMs: 200 });
    transport.emit({ type: "live-caption", role: "user", delta: "Wait", startMs: 100, endMs: 250 });
    transport.emit({ type: "live-caption", role: "agent", delta: " there", startMs: 200, endMs: 500 });
    expect(viz.state).toBe("speaking");
    expect(viz.transcript.getSnapshot().messages.map((row) => row.text)).toEqual(["Hello there", "Wait"]);
    const usage = vi.fn();
    viz.on("usage", usage);
    transport.emit({ type: "session-usage", seconds: 4, final: true, reason: "close_requested" });
    expect(usage).toHaveBeenCalledWith({ seconds: 4, final: true, reason: "close_requested" });
    viz.unmount();
  });

  it("partitions reset caption timestamps only after the next transport connects", async () => {
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    transport.emit({ type: "live-caption", role: "agent", delta: "Old", startMs: 0, endMs: 100 });

    let finishConnect = () => undefined;
    transport.connectHook = () => new Promise<void>((resolve) => {
      finishConnect = () => {
        transport.connected = true;
        transport.emit({ type: "connected" });
        resolve();
      };
    });
    const reconnecting = viz.connect("/session");
    transport.emit({ type: "live-caption", role: "agent", delta: " late", startMs: 100, endMs: 200 });
    finishConnect();
    await reconnecting;
    transport.emit({ type: "live-caption", role: "agent", delta: "New", startMs: 0, endMs: 100 });

    expect(viz.transcript.getSnapshot().messages.map((message) => message.text)).toEqual(["Old late", "New"]);
    viz.unmount();
  });

  it("finishes local cleanup before a disconnected listener reconnects", async () => {
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    transport.emit({ type: "live-caption", role: "agent", delta: "Old", startMs: 0, endMs: 100 });
    const stopReconnect = viz.on("disconnected", () => {
      void viz.connect("/session");
      transport.emit({ type: "live-caption", role: "agent", delta: "New", startMs: 0, endMs: 100 });
    });

    transport.emit({ type: "disconnected" });

    expect(viz.transcript.getSnapshot().messages.map(({ text, status }) => [text, status])).toEqual([
      ["Old", "interrupted"], ["New", "streaming"],
    ]);
    stopReconnect();
    viz.unmount();
  });

  it("surfaces a rejected command without changing state or transcript", async () => {
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    transport.emit({ type: "live-caption", role: "agent", delta: "Hello", startMs: 0, endMs: 100 });
    const state = viz.state;
    const providerError = vi.fn();
    viz.on("providererror", providerError);

    transport.emit({ type: "provider-error", message: "Unknown parameter", code: "unknown_parameter", clientEventId: "evt_1" });

    expect(providerError).toHaveBeenCalledWith({ message: "Unknown parameter", code: "unknown_parameter", clientEventId: "evt_1" });
    expect(viz.state).toBe(state);
    expect(viz.transcript.getSnapshot().messages.map(({ text, status }) => [text, status])).toEqual([["Hello", "streaming"]]);
    viz.unmount();
  });

  it("reports a failed backend response to the host without changing state", async () => {
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    const state = viz.state;
    const backendFailed = vi.fn();
    viz.on("backendfailed", backendFailed);

    transport.emit({ type: "backend-failed", delegationId: "delegation_1", responseId: "resp_1", status: "failed" });

    expect(backendFailed).toHaveBeenCalledWith({ delegationId: "delegation_1", responseId: "resp_1", status: "failed" });
    expect(viz.state).toBe(state);
    viz.unmount();
  });

  it("completes the last Live caption row when a continuous session disconnects", async () => {
    stubAgentAudio();
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    transport.emit({ type: "agent-track", stream: {} as MediaStream, track: { kind: "audio" } as MediaStreamTrack, continuous: true });
    transport.emit({ type: "live-caption", role: "agent", delta: "Hello", startMs: 0, endMs: 100 });

    transport.emit({ type: "disconnected" });

    expect(viz.transcript.getSnapshot().messages.map(({ text, status }) => [text, status])).toEqual([["Hello", "complete"]]);
    viz.unmount();
  });

  it("holds the interrupted state while the cut-off agent audio decays out of the analyser", async () => {
    const agentAudio = stubAgentAudio();
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, presets: [], reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");
    transport.emit({ type: "agent-track", stream: {} as MediaStream, track: { kind: "audio" } as MediaStreamTrack, continuous: true });

    let now = 0;
    const step = (): AgentState => { now += 16; frame!(now); return viz.state; };

    agentAudio.speak();
    const spoken = new Set<AgentState>();
    for (let index = 0; index < 4; index += 1) spoken.add(step());
    expect([...spoken]).toEqual(["speaking"]);

    transport.emit({ type: "user-speech-started" });
    expect(viz.state).toBe("interrupted");

    agentAudio.cut();
    const decaying = new Set<AgentState>();
    for (let index = 0; index < 60; index += 1) decaying.add(step());
    expect([...decaying]).toEqual(["interrupted"]);

    agentAudio.speak();
    expect(step()).toBe("speaking");
    viz.unmount();
  });

  it("keeps an error state after transport cleanup", async () => {
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    viz.mount(document.createElement("div"));
    await viz.connect("/session");

    transport.emit({ type: "error", error: new Error("network lost") });
    transport.emit({ type: "disconnected" });

    expect(viz.state).toBe("error");
    viz.unmount();
  });

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

  it("forwards a tool call to the host and a host result to the transport exactly once", async () => {
    const mount = document.createElement("div");
    const transport = new FakeTransport();
    const viz = new VoiceViz({ transport, reducedMotion: true });
    const calls: RealtimeToolCall[] = [];
    viz.on("toolcall", (call) => calls.push(call));
    viz.mount(mount);
    await viz.connect("/session");
    transport.emit({ type: "user-speech-stopped" });
    expect(viz.state).toBe("thinking");
    const call = { callId: "call_ui", name: "perform_ui_actions", argumentsJson: "{\"actions\":[]}" };
    transport.emit({ type: "tool-call", call });
    expect(calls).toEqual([call]);
    expect(viz.state).toBe("thinking");
    expect(viz.transcript.getSnapshot().messages).toHaveLength(0);
    transport.emit({ type: "response-done" });
    expect(viz.state).toBe("idle");
    const result: RealtimeToolResult = { callId: "call_ui", output: "{\"ok\":true}" };
    viz.submitToolResult(result);
    expect(transport.submitToolResult).toHaveBeenCalledOnce();
    expect(transport.submitToolResult).toHaveBeenCalledWith(result);
    viz.unmount();
  });
});
