import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOpenAIEvent, OpenAILiveTransport, parseLiveSession } from "./openai.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const answer = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } };
function brokerLease() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode("event: ready\n\n"));
    },
  });
  return {
    response: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    close: () => controller?.close(),
    fail: (error: Error) => controller?.error(error),
  };
}

function stubConnection(autoStart = true) {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const deliver = (event: unknown) => listeners.get("message")?.({ data: JSON.stringify(event) });
  const channel = {
    readyState: "connecting",
    send: vi.fn(), close: vi.fn(),
    addEventListener: vi.fn((name: string, listener: (event: { data: string }) => void) => listeners.set(name, listener)),
  };
  const track = { stop: vi.fn() };
  const microphone = { getTracks: () => [track] };
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
    setRemoteDescription = vi.fn(async () => {
      channel.readyState = "open";
      if (autoStart) deliver({ type: "session.started", session: { id: "live_opaque" } });
    });
  }
  const peer = new Peer();
  const constructed = vi.fn();
  vi.stubGlobal("RTCPeerConnection", class { constructor() { constructed(); return peer; } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => microphone) } });
  const lease = brokerLease();
  const fetcher = vi.fn(async (_input, init: RequestInit | undefined) => init?.method === "GET" ? lease.response : Response.json(answer, { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const transport = new OpenAILiveTransport();
  const close = async () => { const done = transport.disconnect(); deliver({ type: "session.closed", usage: { seconds: 4 }, reason: "close_requested" }); await done; };
  const backend = (event: unknown, delegation = "delegation_1") => deliver({ type: "response.event", delegation_id: delegation, event });
  const call = (id: string) => backend({ type: "response.output_item.done", item: { type: "function_call", call_id: id, name: "perform_ui_actions", arguments: "{}" } });
  const created = () => backend({ type: "response.created", response: { id: "resp_1", output: [] } });
  const completed = () => backend({ type: "response.completed", response: { id: "resp_1", output: [] } });
  const sent = () => channel.send.mock.calls.map(([json]) => JSON.parse(String(json)));
  return { transport, channel, peer, constructed, track, fetcher, lease, deliver, close, backend, call, created, completed, sent };
}

function stubMultipleConnections() {
  const peers: Array<{
    channel: { readyState: string; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    deliver(event: unknown): void;
    close: ReturnType<typeof vi.fn>;
    track: { stop: ReturnType<typeof vi.fn> };
  }> = [];
  const leases: ReturnType<typeof brokerLease>[] = [];
  class Peer {
    connectionState = "new";
    iceGatheringState = "complete";
    localDescription = { type: "offer", sdp: "v=0\r\nwith-ice" };
    #listeners = new Map<string, (event: { data: string }) => void>();
    readonly channel = {
      readyState: "connecting",
      send: vi.fn(), close: vi.fn(),
      addEventListener: vi.fn((name: string, listener: (event: { data: string }) => void) => this.#listeners.set(name, listener)),
    };
    readonly track = { stop: vi.fn() };
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    addTrack = vi.fn();
    close = vi.fn();
    createDataChannel = vi.fn(() => this.channel);
    createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0" }));
    setLocalDescription = vi.fn();
    setRemoteDescription = vi.fn(async () => { this.channel.readyState = "open"; });
    constructor() { peers.push(this); }
    deliver(event: unknown): void { this.#listeners.get("message")?.({ data: JSON.stringify(event) }); }
  }
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => {
    const peer = peers.at(-1)!;
    return { getTracks: () => [peer.track] };
  }) } });
  vi.stubGlobal("fetch", vi.fn(async (_input, init: RequestInit | undefined) => {
    if (init?.method !== "GET") return Response.json(answer, { status: 201 });
    const lease = brokerLease();
    leases.push(lease);
    return lease.response;
  }));
  return { transport: new OpenAILiveTransport(), peers, leases };
}

describe("Live events", () => {
  it("preserves timed fragments and keeps backend text out of spoken captions", () => {
    expect(normalizeOpenAIEvent({ type: "session.input_transcript.delta", delta: " I", start_ms: 1, end_ms: 10 })).toEqual([
      { type: "live-caption", role: "user", delta: " I", startMs: 1, endMs: 10 },
    ]);
    expect(normalizeOpenAIEvent({ type: "session.output_transcript.delta", delta: "Hi", start_ms: 1, end_ms: 10 })).toEqual([
      { type: "live-caption", role: "agent", delta: "Hi", startMs: 1, endMs: 10 },
    ]);
    for (const event of [null, [], { type: "session.input_transcript.delta", delta: "x" }, { type: "response.output_audio_transcript.delta", delta: "old" }, { type: "response.event", event: { type: "response.output_text.delta", delta: "backend" } }]) expect(normalizeOpenAIEvent(event)).toEqual([]);
  });

  it("maps a provider error to a recoverable provider-error event", () => {
    expect(normalizeOpenAIEvent({ type: "error", error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter", client_event_id: "evt_1" } })).toEqual([
      { type: "provider-error", message: "Unknown parameter", code: "unknown_parameter", clientEventId: "evt_1" },
    ]);
    expect(normalizeOpenAIEvent({ type: "error", error: {} })).toEqual([
      { type: "provider-error", message: "Live provider error", code: undefined, clientEventId: undefined },
    ]);
  });

  it("validates Live answers and rejects old token payloads", () => {
    expect(parseLiveSession(answer)).toEqual({ id: "live_opaque", sdp: "v=0\r\nanswer" });
    for (const payload of [null, [], {}, { value: "ek_old" }, { ...answer, transport: { type: "webrtc", sdp: " " } }]) expect(() => parseLiveSession(payload)).toThrow("invalid Live session");
  });
});

describe("Live connection", () => {
  it("sends the gathered offer to the BFF without a browser credential or second provider request", async () => {
    const h = stubConnection();
    await h.transport.connect("/session", { responseTiming: "fast", speechRate: 1.15 });
    expect(h.fetcher).toHaveBeenNthCalledWith(1, "/session", expect.objectContaining({
      headers: { Accept: "text/event-stream" }, cache: "no-store", credentials: "omit",
    }));
    expect(h.fetcher).toHaveBeenNthCalledWith(2, "/session", expect.objectContaining({
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ responseTiming: "fast", speechRate: 1.15, sdp: "v=0\r\nwith-ice" }),
    }));
    expect(h.peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: answer.transport.sdp });
    expect(h.transport.connected).toBe(true);
    expect(h.sent()).toEqual([]);
    await h.close();
  });

  it("waits for session.started even when the data channel is open", async () => {
    const h = stubConnection(false);
    const connecting = h.transport.connect("/session");
    await vi.waitFor(() => expect(h.peer.setRemoteDescription).toHaveBeenCalled());
    expect(h.channel.readyState).toBe("open");
    expect(h.transport.connected).toBe(false);
    expect(() => h.transport.submitToolResult({ callId: "x", output: "{}" })).toThrow("not ready");
    h.deliver({ type: "session.started" });
    await connecting;
    await h.close();
  });

  it("does not fulfill startup after a connected listener starts closing", async () => {
    const h = stubConnection();
    h.transport.subscribe((event) => { if (event.type === "connected") void h.transport.disconnect(); });
    await expect(h.transport.connect("/session")).rejects.toThrow();
    expect(h.transport.connected).toBe(false);
    await h.close();
  });

  it("keeps the session open on a rejected command", async () => {
    const h = stubConnection();
    const events: unknown[] = [];
    h.transport.subscribe((event) => events.push(event));
    await h.transport.connect("/session");
    h.deliver({ type: "error", error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter", client_event_id: "evt_1" } });
    expect(events).toEqual([{ type: "connected" }, { type: "provider-error", message: "Unknown parameter", code: "unknown_parameter", clientEventId: "evt_1" }]);
    expect(h.transport.connected).toBe(true);
    expect(h.sent()).toEqual([]);
    await h.close();
  });

  it("releases microphone and peer on a setup failure", async () => {
    const h = stubConnection();
    h.fetcher.mockImplementation(async (_input, init: RequestInit | undefined) => init?.method === "GET" ? h.lease.response : new Response(null, { status: 502 }));
    const events: string[] = [];
    h.transport.subscribe((event) => events.push(event.type));
    await expect(h.transport.connect("/session")).rejects.toThrow("502");
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["error"]);
  });

  it("does not acquire the microphone when the broker lease cannot start", async () => {
    const h = stubConnection();
    h.fetcher.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(h.transport.connect("/session")).rejects.toThrow("broker lease failed with 502");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(h.constructed).not.toHaveBeenCalled();
  });

  it("immediately releases an active session when the broker lease ends", async () => {
    const h = stubConnection();
    const events: string[] = [];
    h.transport.subscribe((event) => events.push(event.type));
    await h.transport.connect("/session");
    h.lease.close();
    await vi.waitFor(() => expect(h.track.stop).toHaveBeenCalledOnce());
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.sent()).toEqual([{ type: "session.close" }]);
    expect(events).toEqual(["connected", "error", "disconnected"]);
  });

  it("immediately releases an active session when the broker lease reader fails", async () => {
    const h = stubConnection();
    const errors: Error[] = [];
    h.transport.subscribe((event) => { if (event.type === "error") errors.push(event.error); });
    await h.transport.connect("/session");
    h.lease.fail(new Error("socket reset"));
    await vi.waitFor(() => expect(h.track.stop).toHaveBeenCalledOnce());
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(errors[0]?.message).toContain("broker disconnected");
  });

  it("does not turn an intentional released abort into a broker error", async () => {
    const h = stubConnection();
    const events: string[] = [];
    h.transport.subscribe((event) => events.push(event.type));
    await h.transport.connect("/session");
    await h.close();
    h.lease.fail(new Error("late abort"));
    await Promise.resolve();
    expect(events).not.toContain("error");
  });

  it("does not wait for final usage when the broker lease ends during closing", async () => {
    const h = stubConnection();
    await h.transport.connect("/session");
    const closing = h.transport.disconnect();
    h.lease.close();
    await closing;
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
  });

  it("times out an unready session when broker heartbeats stop", async () => {
    const h = stubConnection(false);
    vi.useFakeTimers();
    const connecting = h.transport.connect("/session");
    const rejected = expect(connecting).rejects.toThrow("broker heartbeat timed out");
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("releases the microphone as soon as close begins and keeps the peer until final usage arrives", async () => {
    const h = stubConnection();
    const events: unknown[] = [];
    h.transport.subscribe((event) => events.push(event));
    await h.transport.connect("/session");
    h.deliver({ type: "session.usage.updated", usage: { seconds: 2 } });
    const closing = h.transport.disconnect();
    expect(h.transport.disconnect()).toBe(closing);
    expect(h.sent()).toEqual([{ type: "session.close" }]);
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).not.toHaveBeenCalled();
    h.deliver({ type: "session.closed", usage: { seconds: 4 }, reason: "close_requested" });
    await closing;
    expect(events).toContainEqual({ type: "session-usage", seconds: 4, final: true, reason: "close_requested" });
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
  });

  it("reports incomplete finalization and cleans up after the close timeout", async () => {
    const h = stubConnection();
    await h.transport.connect("/session");
    vi.useFakeTimers();
    const errors: Error[] = [];
    h.transport.subscribe((event) => { if (event.type === "error") errors.push(event.error); });
    const closing = h.transport.disconnect();
    await vi.advanceTimersByTimeAsync(15_000);
    await closing;
    expect(errors[0]?.message).toContain("usage is unconfirmed");
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("reports unconfirmed final usage when an active channel is no longer open", async () => {
    const h = stubConnection();
    const errors: Error[] = [];
    h.transport.subscribe((event) => { if (event.type === "error") errors.push(event.error); });
    await h.transport.connect("/session");
    h.channel.readyState = "closed";
    await h.transport.disconnect();
    expect(errors[0]?.message).toContain("usage is unconfirmed");
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("treats a malformed final usage event as unconfirmed before releasing resources", async () => {
    const h = stubConnection();
    const events: string[] = [];
    h.transport.subscribe((event) => events.push(event.type));
    await h.transport.connect("/session");
    const closing = h.transport.disconnect();
    h.deliver({ type: "session.closed", usage: { seconds: "four" } });
    await closing;
    expect(events).toEqual(["connected", "error", "disconnected"]);
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("cancels delayed microphone setup and stops late media without calling the broker", async () => {
    let resolveMicrophone: ((stream: { getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> }) => void) | undefined;
    const peer = { iceGatheringState: "complete", addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() };
    const track = { stop: vi.fn() };
    vi.stubGlobal("RTCPeerConnection", class { constructor() { return peer; } });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => new Promise((resolve) => { resolveMicrophone = resolve; })) } });
    const lease = brokerLease();
    const fetcher = vi.fn(async () => lease.response);
    vi.stubGlobal("fetch", fetcher);
    const transport = new OpenAILiveTransport();
    const connecting = transport.connect("/session");
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    await transport.disconnect();
    resolveMicrophone!({ getTracks: () => [track] });
    await expect(connecting).rejects.toThrow("cancelled");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("only the latest reconnect allocates after an older close drains", async () => {
    const h = stubMultipleConnections();
    const first = h.transport.connect("/session");
    await vi.waitFor(() => expect(h.peers).toHaveLength(1));
    await vi.waitFor(() => expect(h.peers[0]!.channel.readyState).toBe("open"));
    h.peers[0]!.deliver({ type: "session.started" });
    await first;

    const superseded = h.transport.connect("/session");
    const latest = h.transport.connect("/session");
    expect(h.peers[0]!.channel.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.close" }));
    h.peers[0]!.deliver({ type: "session.closed", usage: { seconds: 4 } });

    await expect(superseded).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(h.peers).toHaveLength(2));
    await vi.waitFor(() => expect(h.peers[1]!.channel.readyState).toBe("open"));
    h.peers[1]!.deliver({ type: "session.started" });
    await latest;
    expect(h.peers[0]!.close).toHaveBeenCalledOnce();
    expect(h.peers[0]!.track.stop).toHaveBeenCalledOnce();
    expect(h.transport.connected).toBe(true);

    const closing = h.transport.disconnect();
    h.peers[1]!.deliver({ type: "session.closed", usage: { seconds: 5 } });
    await closing;
    expect(h.peers[1]!.close).toHaveBeenCalledOnce();
    expect(h.peers[1]!.track.stop).toHaveBeenCalledOnce();
  });

  it("does not announce a superseded connect", async () => {
    const h = stubMultipleConnections();
    const types: string[] = [];
    h.transport.subscribe((event) => types.push(event.type));
    const first = h.transport.connect("/session");
    await vi.waitFor(() => expect(h.peers).toHaveLength(1));
    await vi.waitFor(() => expect(h.peers[0]!.channel.readyState).toBe("open"));
    const second = h.transport.connect("/session");
    h.peers[0]!.deliver({ type: "session.started" });
    await expect(first).rejects.toThrow("cancelled");
    expect(types).not.toContain("connected");
    await vi.waitFor(() => expect(h.peers).toHaveLength(2));
    await vi.waitFor(() => expect(h.peers[1]!.channel.readyState).toBe("open"));
    h.peers[1]!.deliver({ type: "session.started" });
    await second;
    expect(types.filter((type) => type === "connected")).toHaveLength(1);
    expect(h.peers[0]!.track.stop).toHaveBeenCalledOnce();
    const closing = h.transport.disconnect();
    h.peers[1]!.deliver({ type: "session.closed", usage: { seconds: 5 } });
    await closing;
  });

  it("ignores a late broker lease failure from a replaced session", async () => {
    const h = stubMultipleConnections();
    const first = h.transport.connect("/session");
    await vi.waitFor(() => expect(h.peers).toHaveLength(1));
    await vi.waitFor(() => expect(h.peers[0]!.channel.readyState).toBe("open"));
    h.peers[0]!.deliver({ type: "session.started" });
    await first;

    const replacement = h.transport.connect("/session");
    h.peers[0]!.deliver({ type: "session.closed", usage: { seconds: 4 } });
    await vi.waitFor(() => expect(h.peers).toHaveLength(2));
    await vi.waitFor(() => expect(h.peers[1]!.channel.readyState).toBe("open"));
    h.peers[1]!.deliver({ type: "session.started" });
    await replacement;
    h.leases[0]!.fail(new Error("late socket reset"));
    await Promise.resolve();
    expect(h.transport.connected).toBe(true);

    const closing = h.transport.disconnect();
    h.peers[1]!.deliver({ type: "session.closed", usage: { seconds: 5 } });
    await closing;
  });
});

describe("Live tool delegation", () => {
  it("collects completed function items, submits every result, and continues once", async () => {
    const h = stubConnection();
    const calls: string[] = [];
    h.transport.subscribe((event) => { if (event.type === "tool-call") calls.push(event.call.callId); });
    await h.transport.connect("/session");
    h.created();
    h.backend({ type: "response.function_call_arguments.done", call_id: "incomplete", arguments: "{}" });
    h.call("a"); h.call("a"); h.call("b");
    expect(calls).toEqual([]);
    h.completed(); h.completed();
    expect(calls).toEqual(["a", "b"]);
    h.transport.submitToolResult({ callId: "a", output: '{"ok":true}' });
    expect(h.sent()).toHaveLength(1);
    h.transport.submitToolResult({ callId: "b", output: '{"code":"cancelled"}' });
    expect(h.sent().map((event) => event.type)).toEqual(["response.item.create", "response.item.create", "response.create"]);
    expect(h.sent()[0].item).toEqual({ type: "function_call_output", call_id: "a", output: '{"ok":true}' });
    expect(h.sent()[2]).toEqual({ type: "response.create", event_id: expect.any(String) });
    expect(() => h.transport.submitToolResult({ callId: "a", output: "{}" })).toThrow("already submitted");
    await h.close();
  });

  it("preserves backend usage separately from voice duration and captions", async () => {
    const h = stubConnection();
    const events: unknown[] = [];
    h.transport.subscribe((event) => events.push(event));
    await h.transport.connect("/session");
    h.created();
    const closing = h.transport.disconnect();
    h.backend({ type: "response.completed", response: { id: "resp_1", output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
    expect(events).toEqual([{ type: "connected" }, { type: "backend-usage", delegationId: "delegation_1", responseId: "resp_1", inputTokens: 10, outputTokens: 4, totalTokens: 14 }]);
    await h.close();
    await closing;
  });

  it("does not execute partial calls from a failed backend response", async () => {
    const h = stubConnection();
    const events: unknown[] = [];
    h.transport.subscribe((event) => events.push(event));
    await h.transport.connect("/session");
    h.created(); h.call("a");
    h.backend({ type: "response.failed", response: { id: "resp_1" } });
    h.completed();
    expect(events).toEqual([{ type: "connected" }, { type: "backend-failed", delegationId: "delegation_1", responseId: "resp_1", status: "failed" }]);
    expect(h.transport.connected).toBe(true);
    expect(h.sent()).toEqual([]);
    expect(() => h.transport.submitToolResult({ callId: "a", output: "{}" })).toThrow("Unknown or already submitted");
    await h.close();
  });

  it("reports a truncated backend response without ending the call", async () => {
    const h = stubConnection();
    const events: unknown[] = [];
    h.transport.subscribe((event) => events.push(event));
    await h.transport.connect("/session");
    h.created();
    h.backend({ type: "response.incomplete", response: { id: "resp_1" } });
    expect(events).toEqual([{ type: "connected" }, { type: "backend-failed", delegationId: "delegation_1", responseId: "resp_1", status: "incomplete" }]);
    expect(h.transport.connected).toBe(true);
    expect(h.sent()).toEqual([]);
    await h.close();
  });

  it("keeps a newer batch when an older response fails", async () => {
    const h = stubConnection();
    const calls: string[] = [];
    h.transport.subscribe((event) => { if (event.type === "tool-call") calls.push(event.call.callId); });
    await h.transport.connect("/session");
    h.created();
    h.backend({ type: "response.created", response: { id: "resp_2", output: [] } });
    h.backend({ type: "response.failed", response: { id: "resp_1" } });
    h.call("b");
    h.backend({ type: "response.completed", response: { id: "resp_2", output: [] } });
    expect(calls).toEqual(["b"]);
    await h.close();
  });

  it("closes the session after a tool continuation send failure", async () => {
    const h = stubConnection();
    const types: string[] = [];
    h.transport.subscribe((event) => types.push(event.type));
    await h.transport.connect("/session");
    h.created(); h.call("a"); h.completed();
    h.channel.send.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("channel closed"); });
    expect(() => h.transport.submitToolResult({ callId: "a", output: "{}" })).toThrow("channel closed");
    expect(types).toEqual(["connected", "tool-call", "error", "disconnected"]);
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("stops queued tool calls after a tool listener closes the session", async () => {
    const h = stubConnection();
    const calls: string[] = [];
    h.transport.subscribe((event) => {
      if (event.type !== "tool-call") return;
      calls.push(event.call.callId);
      expect(() => h.transport.submitToolResult({ callId: event.call.callId, output: "{}" })).toThrow("channel closed");
    });
    await h.transport.connect("/session");
    h.created(); h.call("a"); h.call("b");
    h.channel.send.mockImplementation(() => { throw new Error("channel closed"); });
    h.completed();
    expect(calls).toEqual(["a"]);
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("does not notify a replacement session that an old terminal path disconnected", async () => {
    const h = stubMultipleConnections();
    const first = h.transport.connect("/session");
    await vi.waitFor(() => expect(h.peers).toHaveLength(1));
    await vi.waitFor(() => expect(h.peers[0]!.channel.readyState).toBe("open"));
    h.peers[0]!.deliver({ type: "session.started" });
    await first;
    h.peers[0]!.deliver({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.created", response: { id: "resp_1", output: [] } } });
    h.peers[0]!.deliver({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "a", name: "perform_ui_actions", arguments: "{}" } } });
    h.peers[0]!.deliver({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.completed", response: { id: "resp_1", output: [] } } });

    let replacement: Promise<void> | undefined;
    let disconnected = 0;
    h.transport.subscribe((event) => {
      if (event.type === "error") replacement = h.transport.connect("/session");
      if (event.type === "disconnected") disconnected += 1;
    });
    h.peers[0]!.channel.send.mockImplementation(() => { throw new Error("channel closed"); });
    expect(() => h.transport.submitToolResult({ callId: "a", output: "{}" })).toThrow("channel closed");
    await vi.waitFor(() => expect(h.peers).toHaveLength(2));
    await vi.waitFor(() => expect(h.peers[1]!.channel.readyState).toBe("open"));
    h.peers[1]!.deliver({ type: "session.started" });
    await replacement;
    expect(disconnected).toBe(0);
    expect(h.transport.connected).toBe(true);
    const closing = h.transport.disconnect();
    h.peers[1]!.deliver({ type: "session.closed", usage: { seconds: 5 } });
    await closing;
    expect(disconnected).toBe(1);
  });
});
