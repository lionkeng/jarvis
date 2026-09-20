import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolId } from "./broker.js";
import { createLiveTransport, LiveTransport } from "./live-transport.js";
import type { RealtimeTransport } from "./types.js";

afterEach(() => { vi.unstubAllGlobals(); });

const grant = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } };

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
    const transport = createLiveTransport({ protocol: "gemini-live" as unknown as ProtocolId });
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
});
