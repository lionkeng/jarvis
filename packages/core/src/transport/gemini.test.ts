import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_GRANT, GEMINI_POST_BODY, READY_PLAN_PAYLOAD } from "../../../../scripts/fixtures/session-wire.js";
import { LiveTransport } from "./live-transport.js";
import type { NormalizedRealtimeEvent } from "./types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const PREFERENCES = { responseTiming: GEMINI_POST_BODY.responseTiming, speechRate: GEMINI_POST_BODY.speechRate } as const;
const STANDARD_MODEL = "models/gemini-3.8-live";
const EXTENDED_MODEL = "models/gemini-3.8-live-extended-thinking";

function grantFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...GEMINI_GRANT, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), ...overrides };
}

class FakeSocket {
  static readonly all: FakeSocket[] = [];
  static handshake = true;
  static stall = false;
  static trailing: unknown[][] = [];
  readyState = 0;
  binaryType = "";
  closed: number | undefined;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => { if (this.readyState === 0) this.accept(); });
  }

  addEventListener(name: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: never) => void): void { this.#listeners.get(name)?.delete(listener); }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    if (!FakeSocket.handshake || this.sent.length !== 1) return;
    this.deliver(JSON.stringify({ setupComplete: {} }));
    for (const frame of FakeSocket.trailing[FakeSocket.all.indexOf(this)] ?? []) this.deliver(JSON.stringify(frame));
  }

  close(code = 1000): void {
    if (FakeSocket.stall) { this.readyState = 2; return; }
    this.drop(code);
  }

  accept(): void { this.readyState = 1; this.#emit("open", {}); }
  drop(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = code;
    this.#emit("close", { code, reason });
  }
  deliver(data: unknown): void { this.#emit("message", { data }); }
  #emit(name: string, event: unknown): void { for (const listener of [...this.#listeners.get(name) ?? []]) (listener as (value: unknown) => void)(event); }
}

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | undefined;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeContext {
  static readonly instances: FakeContext[] = [];
  currentTime = 0;
  state = "running";
  readonly destination = { kind: "speakers" };
  readonly sources: FakeSource[] = [];
  readonly track = { stop: vi.fn() };
  readonly sink = { stream: { getAudioTracks: () => [this.track] }, connect: vi.fn(), disconnect: vi.fn() };
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  readonly sampleRate: number;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => { this.state = "closed"; });
  createMediaStreamSource = vi.fn(() => new FakeNode());
  createMediaStreamDestination = vi.fn(() => this.sink);
  createBuffer = vi.fn((_channels: number, length: number, rate: number) => ({
    duration: length / rate, sampleRate: rate, getChannelData: () => new Float32Array(length),
  }));
  createBufferSource = vi.fn(() => { const source = new FakeSource(); this.sources.push(source); return source; });
  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
    FakeContext.instances.push(this);
  }
}

class FakeWorklet extends FakeNode {
  static readonly all: FakeWorklet[] = [];
  readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null };
  constructor() { super(); FakeWorklet.all.push(this); }
}

function brokerLease() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode(`event: ready\ndata: ${JSON.stringify(READY_PLAN_PAYLOAD)}\n\n`));
    },
  });
  return {
    response: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    beat: () => controller?.enqueue(new TextEncoder().encode(": beat\n\n")),
    close: () => controller?.close(),
  };
}

function stubGemini(grant: Record<string, unknown> = grantFor()) {
  FakeSocket.all.length = 0;
  FakeSocket.handshake = true;
  FakeSocket.stall = false;
  FakeSocket.trailing = [];
  FakeContext.instances.length = 0;
  FakeWorklet.all.length = 0;
  const microphoneTrack = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [microphoneTrack] }));
  const peers = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorklet);
  vi.stubGlobal("RTCPeerConnection", class { constructor() { peers(); } });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:jarvis-pcm");
    static revokeObjectURL = vi.fn();
  });
  vi.stubGlobal("WebSocket", FakeSocket);
  const lease = brokerLease();
  const fetcher = vi.fn(async (_input: unknown, init: RequestInit | undefined) => init?.method === "GET" ? lease.response : Response.json(grant, { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const transport = new LiveTransport({ protocol: "gemini-live" });
  const events: NormalizedRealtimeEvent[] = [];
  transport.subscribe((event) => events.push(event));
  return {
    transport, events, fetcher, lease, getUserMedia, microphoneTrack, peers,
    types: () => events.map((event) => event.type),
    socket: (index = 0) => FakeSocket.all[index]!,
    playback: () => FakeContext.instances[0]!,
    body: () => JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as Record<string, unknown>,
    frames: (index = 0) => FakeSocket.all[index]!.sent,
    connect: () => transport.connect("/session", PREFERENCES),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function audio(samples: number[]): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return btoa(String.fromCharCode(...new Uint8Array(view.buffer)));
}

const modelTurn = (data: string) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }] } } });

describe("Gemini live channel", () => {
  it("opens the socket with the minted token and sends the grant setup verbatim", async () => {
    const h = stubGemini();
    await h.connect();
    expect(h.body()).toEqual(GEMINI_POST_BODY);
    expect(h.socket().url).toBe(`${GEMINI_GRANT.endpoint}?access_token=${encodeURIComponent(GEMINI_GRANT.token)}`);
    expect(h.socket().binaryType).toBe("arraybuffer");
    expect(h.frames()[0]).toEqual(GEMINI_GRANT.setup);
    expect(h.peers).not.toHaveBeenCalled();
    expect(h.transport.connected).toBe(true);
    const track = h.events.find((event) => event.type === "agent-track");
    expect(track).toMatchObject({ continuous: true, stream: h.playback().sink.stream });
    await h.transport.disconnect();
  });

  it("streams capture chunks as realtime audio at the real capture rate", async () => {
    const h = stubGemini();
    await h.connect();
    FakeWorklet.all[0]!.port.onmessage!({ data: Float32Array.of(0, 1, -1) });
    expect(h.frames()[1]).toEqual({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: audio([0, 32_767, -32_768]) } } });
    await h.transport.disconnect();
  });

  it("echoes the tool name back with the result", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify({ toolCall: { functionCalls: [{ id: "call_1", name: "perform_ui_actions", args: { steps: [] } }] } }));
    await tick();
    expect(h.events.at(-1)).toEqual({ type: "tool-call", call: { callId: "call_1", name: "perform_ui_actions", argumentsJson: '{"steps":[]}' } });
    h.transport.submitToolResult({ callId: "call_1", output: '{"ok":true}' });
    expect(h.frames()[1]).toEqual({ toolResponse: { functionResponses: [{ id: "call_1", name: "perform_ui_actions", response: { ok: true } }] } });
    expect(() => h.transport.submitToolResult({ callId: "call_1", output: "{}" })).toThrow("Unknown or already submitted");
    await h.transport.disconnect();
  });

  it("sends id, name and response alone on every model", async () => {
    for (const model of [STANDARD_MODEL, EXTENDED_MODEL]) {
      const h = stubGemini(grantFor({ setup: { setup: { model } } }));
      await h.connect();
      h.socket().deliver(JSON.stringify({ toolCall: { functionCalls: [{ id: "call_1", name: "perform_ui_actions" }] } }));
      await tick();
      expect(h.events.at(-1)).toMatchObject({ call: { argumentsJson: "{}" } });
      h.transport.submitToolResult({ callId: "call_1", output: "done" });
      const sent = h.frames()[1] as { toolResponse: { functionResponses: Array<Record<string, unknown>> } };
      expect(sent.toolResponse.functionResponses).toEqual([{ id: "call_1", name: "perform_ui_actions", response: { result: "done" } }]);
      expect(Object.keys(sent.toolResponse.functionResponses[0]!)).toEqual(["id", "name", "response"]);
      await h.transport.disconnect();
    }
  });

  it("drops pending calls on barge-in, flushes playback, and makes a late result a no-op", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify(modelTurn(audio([1, 2, 3]))));
    h.socket().deliver(JSON.stringify({ toolCall: { functionCalls: [{ id: "call_1", name: "perform_ui_actions" }] } }));
    await tick();
    expect(h.playback().sources).toHaveLength(1);
    h.socket().deliver(JSON.stringify({ serverContent: { interrupted: true } }));
    await tick();
    expect(h.playback().sources[0]!.stop).toHaveBeenCalledOnce();
    expect(h.types()).toContain("user-speech-started");
    expect(() => h.transport.submitToolResult({ callId: "call_1", output: "{}" })).not.toThrow();
    expect(h.frames()).toHaveLength(1);
    expect(() => h.transport.submitToolResult({ callId: "call_9", output: "{}" })).toThrow("Unknown or already submitted");
    await h.transport.disconnect();
  });

  it("drops only the cancelled call ids", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify({ toolCall: { functionCalls: [{ id: "a", name: "perform_ui_actions" }, { id: "b", name: "perform_ui_actions" }] } }));
    h.socket().deliver(JSON.stringify({ toolCallCancellation: { ids: ["a"] } }));
    await tick();
    expect(() => h.transport.submitToolResult({ callId: "a", output: "{}" })).not.toThrow();
    h.transport.submitToolResult({ callId: "b", output: "{}" });
    expect(h.frames()).toHaveLength(2);
    await h.transport.disconnect();
  });

  it("buffers input transcription into one user turn and streams the agent transcript", async () => {
    const h = stubGemini();
    await h.connect();
    for (const text of [" Open", " the", " dashboard"]) h.socket().deliver(JSON.stringify({ serverContent: { inputTranscription: { text } } }));
    await tick();
    expect(h.types()).not.toContain("user-text");
    h.socket().deliver(JSON.stringify({ serverContent: { outputTranscription: { text: "Sure" } } }));
    h.socket().deliver(JSON.stringify({ serverContent: { outputTranscription: { text: ", opening it." } } }));
    h.socket().deliver(JSON.stringify({ serverContent: { turnComplete: true } }));
    await tick();
    expect(h.events.slice(2)).toEqual([
      { type: "user-text", text: "Open the dashboard" },
      { type: "agent-text-delta", delta: "Sure", audioSynchronized: true },
      { type: "agent-text-delta", delta: ", opening it.", audioSynchronized: true },
      { type: "agent-text-done", audioSynchronized: true },
      { type: "response-done" },
    ]);
    expect(h.types()).not.toContain("live-caption");
    await h.transport.disconnect();
  });

  it("keeps a tool-only turn out of the transcript and closes the spoken turn that follows", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify({ toolCall: { functionCalls: [{ id: "call_1", name: "perform_ui_actions" }] } }));
    h.socket().deliver(JSON.stringify({ serverContent: { generationComplete: true } }));
    h.socket().deliver(JSON.stringify({ serverContent: { turnComplete: true, usageMetadata: { totalTokenCount: 40 } } }));
    await tick();
    expect(h.types().slice(2)).toEqual(["tool-call"]);
    h.transport.submitToolResult({ callId: "call_1", output: '{"ok":true}' });
    h.socket().deliver(JSON.stringify({ ...modelTurn(audio([1, 2])), serverContent: { ...modelTurn(audio([1, 2])).serverContent, outputTranscription: { text: "Opened it." } } }));
    h.socket().deliver(JSON.stringify({ serverContent: { turnComplete: true } }));
    await tick();
    expect(h.types().slice(2)).toEqual(["tool-call", "agent-text-delta", "agent-text-done", "response-done"]);
    await h.transport.disconnect();
  });

  it("closes an audio-only turn without a text done event", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify(modelTurn(audio([1, 2]))));
    h.socket().deliver(JSON.stringify({ serverContent: { turnComplete: true } }));
    h.socket().deliver(JSON.stringify({ serverContent: { turnComplete: true } }));
    await tick();
    expect(h.types().slice(2)).toEqual(["response-done"]);
    await h.transport.disconnect();
  });

  it("forgets a half-spoken turn after a barge-in", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify({ serverContent: { outputTranscription: { text: "Let me" } } }));
    h.socket().deliver(JSON.stringify({ serverContent: { interrupted: true } }));
    h.socket().deliver(JSON.stringify({ serverContent: { turnComplete: true } }));
    await tick();
    expect(h.types().slice(2)).toEqual(["agent-text-delta", "user-speech-started"]);
    await h.transport.disconnect();
  });

  it("keeps a resumption handle that arrives in the same tick as setupComplete", async () => {
    const h = stubGemini();
    FakeSocket.trailing = [
      [{ sessionResumptionUpdate: { newHandle: "handle_1", resumable: true } }],
      [{ sessionResumptionUpdate: { newHandle: "handle_2", resumable: true } }],
    ];
    await h.connect();
    h.socket(0).deliver(JSON.stringify({ goAway: { timeLeft: "10s" } }));
    await tick();
    expect(h.frames(1)[0]).toMatchObject({ setup: { sessionResumption: { handle: "handle_1" } } });
    h.socket(1).deliver(JSON.stringify({ goAway: { timeLeft: "10s" } }));
    await tick();
    expect(h.frames(2)[0]).toMatchObject({ setup: { sessionResumption: { handle: "handle_2" } } });
    expect(h.types()).not.toContain("disconnected");
    expect(h.transport.connected).toBe(true);
    await h.transport.disconnect();
  });

  it("gives up on a socket that opens but never completes setup", async () => {
    const h = stubGemini();
    FakeSocket.handshake = false;
    vi.useFakeTimers();
    const rejected = expect(h.connect()).rejects.toThrow("setup timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    h.lease.beat();
    await vi.advanceTimersByTimeAsync(5_100);
    await rejected;
    expect(h.socket().closed).toBe(1000);
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(h.transport.connected).toBe(false);
  });

  it("decodes string, ArrayBuffer and Blob frames alike", async () => {
    const h = stubGemini();
    await h.connect();
    const frame = (value: unknown) => JSON.stringify({ serverContent: { outputTranscription: { text: String(value) } } });
    h.socket().deliver(frame("string"));
    h.socket().deliver(new TextEncoder().encode(frame("buffer")).buffer);
    h.socket().deliver(new Blob([frame("blob")]));
    await tick();
    expect(h.events.filter((event) => event.type === "agent-text-delta").map((event) => event.delta)).toEqual(["string", "buffer", "blob"]);
    await h.transport.disconnect();
  });

  it("resumes on goAway without announcing a reconnect", async () => {
    const h = stubGemini();
    await h.connect();
    const track = h.events.find((event) => event.type === "agent-track");
    h.socket().deliver(JSON.stringify({ sessionResumptionUpdate: { newHandle: "handle_1", resumable: true } }));
    h.socket().deliver(JSON.stringify({ goAway: { timeLeft: "10s" } }));
    await tick();
    expect(FakeSocket.all).toHaveLength(2);
    expect(h.socket(1).url).toBe(h.socket(0).url);
    expect(h.frames(1)[0]).toEqual({ setup: { ...GEMINI_GRANT.setup.setup, sessionResumption: { handle: "handle_1" } } });
    expect(h.socket(0).closed).toBe(1000);
    expect(h.types()).not.toContain("disconnected");
    expect(h.types().filter((type) => type === "connected")).toHaveLength(1);
    expect(h.events.find((event) => event.type === "agent-track")).toBe(track);
    expect(h.transport.connected).toBe(true);
    FakeWorklet.all[0]!.port.onmessage!({ data: Float32Array.of(0) });
    expect(h.frames(1)).toHaveLength(2);
    await h.transport.disconnect();
  });

  it("ends with an error when no resumable handle exists", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify({ sessionResumptionUpdate: { newHandle: "handle_1", resumable: false } }));
    h.socket().deliver(JSON.stringify({ goAway: { timeLeft: "10s" } }));
    await tick();
    expect(FakeSocket.all).toHaveLength(1);
    expect(h.types()).toEqual(["agent-track", "connected", "error", "disconnected"]);
    expect(h.transport.connected).toBe(false);
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("ends with an error when the resumed socket never completes setup", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().deliver(JSON.stringify({ sessionResumptionUpdate: { newHandle: "handle_1", resumable: true } }));
    FakeSocket.handshake = false;
    h.socket().deliver(JSON.stringify({ goAway: { timeLeft: "10s" } }));
    await tick();
    h.socket(1).drop(1011);
    await tick();
    expect(h.types()).toEqual(["agent-track", "connected", "error", "disconnected"]);
    expect(h.transport.connected).toBe(false);
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when the socket drops during an active session", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().drop(1006);
    await tick();
    expect(h.events.find((event) => event.type === "error")?.error.message)
      .toBe("Live connection lost with code 1006; final session usage is unconfirmed");
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("repeats the provider's close reason in the error", async () => {
    const h = stubGemini();
    await h.connect();
    h.socket().drop(1007, "Function response scheduling is not supported for this model.");
    await tick();
    expect(h.events.find((event) => event.type === "error")?.error.message)
      .toBe("Live connection lost with code 1007: Function response scheduling is not supported for this model.; final session usage is unconfirmed");
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("repeats a close reason that arrives before setup completes", async () => {
    const h = stubGemini();
    FakeSocket.handshake = false;
    const rejected = expect(h.connect()).rejects.toThrow("Live connection closed before setup: token expired; final session usage is unconfirmed");
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    await tick();
    h.socket().drop(1008, "token expired");
    await rejected;
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("releases the socket and the microphone when the broker lease ends", async () => {
    const h = stubGemini();
    await h.connect();
    h.lease.close();
    await vi.waitFor(() => expect(h.microphoneTrack.stop).toHaveBeenCalledOnce());
    expect(h.socket().closed).toBe(1000);
    expect(h.types()).toEqual(["agent-track", "connected", "error", "disconnected"]);
  });

  it("ends with an error at the token expiry without reminting", async () => {
    const h = stubGemini(grantFor({ expiresAt: new Date(Date.now() + 30).toISOString() }));
    await h.connect();
    await vi.waitFor(() => expect(h.types()).toContain("error"));
    expect(h.events.find((event) => event.type === "error")?.error.message).toContain("token expired");
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("closes with code 1000 and resolves on the socket close", async () => {
    const h = stubGemini();
    await h.connect();
    let settled = false;
    const closing = h.transport.disconnect().then(() => { settled = true; });
    expect(h.socket().closed).toBe(1000);
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
    await closing;
    expect(settled).toBe(true);
    expect(h.transport.connected).toBe(false);
    expect(h.types()).toEqual(["agent-track", "connected", "disconnected"]);
  });

  it("resolves a stalled close on the fallback timeout", async () => {
    const h = stubGemini();
    await h.connect();
    FakeSocket.stall = true;
    vi.useFakeTimers();
    let settled = false;
    const closing = h.transport.disconnect().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(settled).toBe(false);
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    await closing;
    expect(settled).toBe(true);
    expect(h.transport.connected).toBe(false);
  });

  it("rejects a grant that is not a websocket token", async () => {
    const h = stubGemini({ session: { id: "live_x" }, transport: { type: "webrtc", sdp: "v=0\r\n" } });
    await expect(h.connect()).rejects.toThrow("invalid Live session");
    expect(FakeSocket.all).toHaveLength(0);
    expect(h.getUserMedia).not.toHaveBeenCalled();
  });
});
