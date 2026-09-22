import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_GRANT } from "../../../../scripts/fixtures/session-wire.js";
import { createLiveTransport, LiveTransport } from "./live-transport.js";
import type { RealtimeTransport } from "./types.js";

afterEach(() => { vi.unstubAllGlobals(); });

const grant = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } };

function stubGemini(protocols: string[]) {
  const sockets: Array<{ url: string; closed: boolean }> = [];
  const peers = vi.fn();
  class Socket {
    readyState = 0;
    binaryType = "";
    readonly record: { url: string; closed: boolean };
    #listeners = new Map<string, (event: unknown) => void>();
    constructor(readonly url: string) {
      this.record = { url, closed: false };
      sockets.push(this.record);
      queueMicrotask(() => { this.readyState = 1; this.#listeners.get("open")?.({}); });
    }
    addEventListener(name: string, listener: (event: unknown) => void): void { this.#listeners.set(name, listener); }
    removeEventListener(name: string): void { this.#listeners.delete(name); }
    send(): void { this.#listeners.get("message")?.({ data: JSON.stringify({ setupComplete: {} }) }); }
    close(): void { this.record.closed = true; this.readyState = 3; this.#listeners.get("close")?.({ code: 1000 }); }
  }
  class Context {
    sampleRate = 16_000;
    state = "running";
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createMediaStreamDestination = vi.fn(() => ({ stream: { getAudioTracks: () => [{ stop: vi.fn() }] }, disconnect: vi.fn() }));
  }
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", class { port = { onmessage: null }; connect = vi.fn(); disconnect = vi.fn(); });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:jarvis-pcm");
    static revokeObjectURL = vi.fn();
  });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("RTCPeerConnection", class { constructor() { peers(); } });
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init: RequestInit | undefined) => init?.method === "GET"
    ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${JSON.stringify({ protocols })}\n\n`)); },
    }), { headers: { "Content-Type": "text/event-stream" } })
    : Response.json({ ...GEMINI_GRANT, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }, { status: 201 })));
  return { sockets, peers, track, getUserMedia };
}

function stubLive(ready = "{}") {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const deliver = (event: unknown) => listeners.get("message")?.({ data: JSON.stringify(event) });
  const channel = {
    readyState: "connecting",
    send: vi.fn(), close: vi.fn(),
    addEventListener: vi.fn((name: string, listener: (event: { data: string }) => void) => listeners.set(name, listener)),
  };
  const track = { stop: vi.fn() };
  const peers: Peer[] = [];
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
      deliver({ type: "session.started" });
    });
    constructor() { peers.push(this); }
  }
  vi.stubGlobal("RTCPeerConnection", Peer);
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const fetcher = vi.fn(async (_input: unknown, init: RequestInit | undefined) => init?.method === "GET"
    ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${ready}\n\n`)); },
    }), { headers: { "Content-Type": "text/event-stream" } })
    : Response.json(grant, { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const sent = () => channel.send.mock.calls.map(([json]) => JSON.parse(String(json)) as { type: string });
  return { peers, channel, track, fetcher, getUserMedia, deliver, sent };
}

async function finish(transport: RealtimeTransport, live: ReturnType<typeof stubLive>): Promise<void> {
  const done = transport.disconnect();
  live.deliver({ type: "session.closed", usage: { seconds: 4 } });
  await done;
}

describe("Live transport", () => {
  it("runs the OpenAI channel for a default transport against a legacy plan", async () => {
    const live = stubLive();
    const transport = new LiveTransport();
    await transport.connect("/session", { responseTiming: "natural", speechRate: 1 });
    expect(transport.connected).toBe(true);
    expect(live.peers).toHaveLength(1);
    expect(live.fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(JSON.parse(String(live.fetcher.mock.calls[1]?.[1]?.body))).toEqual({ responseTiming: "natural", speechRate: 1, sdp: "v=0\r\nwith-ice" });
    expect(live.peers[0]!.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: grant.transport.sdp });
    await finish(transport, live);
  });

  it("rejects a pinned protocol the broker does not offer before touching the microphone", async () => {
    const live = stubLive();
    const transport = createLiveTransport({ protocol: "gemini-live" });
    await expect(transport.connect("/session")).rejects.toThrow("does not offer the gemini-live protocol");
    expect(live.getUserMedia).not.toHaveBeenCalled();
    expect(live.peers).toHaveLength(0);
    expect(transport.connected).toBe(false);
  });

  it("builds no peer connection when the broker lease fails", async () => {
    const live = stubLive();
    live.fetcher.mockResolvedValueOnce(new Response(null, { status: 502 }));
    const transport = new LiveTransport();
    await expect(transport.connect("/session")).rejects.toThrow("broker lease failed with 502");
    expect(live.peers).toHaveLength(0);
    expect(live.getUserMedia).not.toHaveBeenCalled();
  });

  it("connects a transport pinned to the OpenAI protocol", async () => {
    const live = stubLive();
    const transport = createLiveTransport({ protocol: "openai-live" });
    await transport.connect("/session");
    expect(transport.connected).toBe(true);
    await finish(transport, live);
  });

  it("awaits the channel close discipline before a disconnect resolves", async () => {
    const live = stubLive();
    const transport = new LiveTransport();
    await transport.connect("/session");
    let settled = false;
    const closing = transport.disconnect().then(() => { settled = true; });
    expect(live.sent()).toEqual([{ type: "session.close" }]);
    expect(live.track.stop).toHaveBeenCalledOnce();
    expect(live.peers[0]!.close).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(settled).toBe(false);
    live.deliver({ type: "session.closed", usage: { seconds: 4 } });
    await closing;
    expect(settled).toBe(true);
    expect(transport.connected).toBe(false);
    expect(live.peers[0]!.close).toHaveBeenCalledOnce();
  });

  it("runs the Gemini channel on a WebSocket without ever building a peer connection", async () => {
    const live = stubGemini(["openai-live", "gemini-live"]);
    const transport = createLiveTransport({ protocol: "gemini-live" });
    await transport.connect("/session");
    expect(transport.connected).toBe(true);
    expect(live.peers).not.toHaveBeenCalled();
    expect(live.sockets[0]?.url).toContain("access_token=");
    await transport.disconnect();
    expect(live.sockets[0]?.closed).toBe(true);
    expect(live.track.stop).toHaveBeenCalledOnce();
  });

  it("picks Gemini for an unpinned transport when the broker offers it alone", async () => {
    const live = stubGemini(["gemini-live"]);
    const transport = new LiveTransport();
    await transport.connect("/session");
    expect(transport.connected).toBe(true);
    expect(live.sockets).toHaveLength(1);
    expect(live.peers).not.toHaveBeenCalled();
    await transport.disconnect();
  });
});
