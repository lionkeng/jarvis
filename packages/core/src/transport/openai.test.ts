import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOpenAIEvent, OpenAIRealtimeTransport, parseEphemeralSession } from "./openai.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI event normalization", () => {
  it("normalizes speech boundaries", () => {
    expect(normalizeOpenAIEvent({ type: "input_audio_buffer.speech_started" })).toEqual([{ type: "user-speech-started" }]);
    expect(normalizeOpenAIEvent({ type: "input_audio_buffer.speech_stopped" })).toEqual([{ type: "user-speech-stopped" }]);
  });

  it("normalizes GA transcript deltas", () => {
    expect(normalizeOpenAIEvent({ type: "response.output_audio_transcript.delta", delta: "Hello" })).toEqual([
      { type: "agent-audio-started" },
      { type: "agent-text-delta", delta: "Hello", audioSynchronized: true },
    ]);
    expect(normalizeOpenAIEvent({ type: "response.output_text.delta", delta: "Visible now" })).toEqual([
      { type: "agent-text-delta", delta: "Visible now" },
    ]);
    expect(normalizeOpenAIEvent({ type: "response.output_audio.done" })).toEqual([]);
  });

  it("does not leak unknown provider events", () => {
    expect(normalizeOpenAIEvent({ type: "rate_limits.updated" })).toEqual([]);
  });

  it("accepts current and nested client-secret payloads but rejects expired secrets", () => {
    expect(parseEphemeralSession({ value: "ek_direct", expires_at: 2_000 }, 1_000_000)).toEqual({ value: "ek_direct", expiresAt: 2_000 });
    expect(parseEphemeralSession({ client_secret: { value: "ek_nested", expires_at: 2_000 } }, 1_000_000)).toEqual({ value: "ek_nested", expiresAt: 2_000 });
    expect(() => parseEphemeralSession({ value: "ek_expired", expires_at: 999 }, 1_000_000)).toThrow("expired");
  });

  it("leaves a failed connection in the error event instead of overwriting it with disconnected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 502 })));
    const transport = new OpenAIRealtimeTransport();
    const events: string[] = [];
    transport.subscribe((event) => events.push(event.type));
    await expect(transport.connect("/session")).rejects.toThrow("Session endpoint failed with 502");
    expect(events).toEqual(["error"]);
    expect(transport.connected).toBe(false);
  });

  it("posts a raw SDP offer with the ephemeral token", async () => {
    const localTrack = { stop: vi.fn() };
    const localStream = { getTracks: () => [localTrack] };
    const channelListeners = new Map<string, () => void>();
    const channel = {
      readyState: "connecting",
      addEventListener: vi.fn((name: string, listener: () => void) => channelListeners.set(name, listener)),
      close: vi.fn(),
    };
    const setRemoteDescription = vi.fn();
    class FakePeerConnection {
      connectionState = "new";
      iceConnectionState = "new";
      addEventListener = vi.fn();
      addTrack = vi.fn();
      close = vi.fn();
      createDataChannel = vi.fn(() => channel);
      createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0\r\no=jarvis-test" }));
      setLocalDescription = vi.fn();
      setRemoteDescription = vi.fn(async (...args: unknown[]) => {
        setRemoteDescription(...args);
        channel.readyState = "open";
        channelListeners.get("open")?.();
      });
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => localStream) } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ value: "ek_live", expires_at: Math.floor(Date.now() / 1_000) + 60 }))
      .mockResolvedValueOnce(new Response("v=0\r\no=openai-answer", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const transport = new OpenAIRealtimeTransport();
    await transport.connect("/session", { responseTiming: "fast", speechRate: 1.15 });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/session", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ responseTiming: "fast", speechRate: 1.15 }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: "Bearer ek_live", "Content-Type": "application/sdp" },
      body: "v=0\r\no=jarvis-test",
    });
    expect(setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0\r\no=openai-answer" });
    expect(transport.connected).toBe(true);
    transport.disconnect();
    expect(localTrack.stop).toHaveBeenCalledOnce();
  });
});
