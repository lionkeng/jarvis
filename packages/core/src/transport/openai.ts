import { parseGrant } from "./broker.js";
import { LiveToolBatches, normalizeOpenAIEvent, record } from "./live-events.js";
import type { LiveChannel, LiveChannelAbort, LiveChannelHost } from "./live-transport.js";
import type { RealtimeToolResult } from "./types.js";
export { normalizeOpenAIEvent } from "./live-events.js";

export function parseLiveSession(value: unknown): { id: string; sdp: string } {
  const grant = parseGrant(value);
  if (grant.kind !== "webrtc-answer") throw new Error("Session endpoint returned an invalid Live session");
  return { id: grant.sessionId, sdp: grant.answerSdp };
}

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new Error("Live connection cancelled")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("ICE gathering timed out")); }, 10_000);
    peer.addEventListener("icegatheringstatechange", check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

export class OpenAILiveChannel implements LiveChannel {
  readonly #events = new AbortController();
  readonly #tools = new LiveToolBatches();
  #peer: RTCPeerConnection | undefined;
  #host: LiveChannelHost | undefined;
  #channel: RTCDataChannel | undefined;
  #microphone: MediaStream | undefined;
  #running = false;
  #released = false;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;

  runnable(): boolean {
    return typeof RTCPeerConnection === "function" && typeof navigator !== "undefined" && navigator.mediaDevices !== undefined;
  }

  async open(host: LiveChannelHost): Promise<void> {
    if (typeof RTCPeerConnection !== "function") throw new Error("Live WebRTC is unavailable in this environment");
    const peer = new RTCPeerConnection();
    this.#peer = peer;
    this.#host = host;
    const listenerOptions = { signal: this.#events.signal };
    peer.addEventListener("connectionstatechange", () => {
      if (["closed", "disconnected", "failed"].includes(peer.connectionState)) this.#lost();
    }, listenerOptions);
    peer.addEventListener("track", ({ track, streams }) => {
      if (track.kind !== "audio") return;
      host.emit({ type: "agent-track", stream: streams[0] ?? new MediaStream([track]), track, continuous: true });
    }, listenerOptions);
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    try {
      host.guard();
      if (this.#released) throw new Error("Live connection cancelled");
    } catch (error) {
      microphone.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.#microphone = microphone;
    for (const track of microphone.getTracks()) peer.addTrack(track, microphone);
    const channel = peer.createDataChannel("oai-events");
    this.#channel = channel;
    channel.addEventListener("close", () => this.#lost(), listenerOptions);
    channel.addEventListener("error", () => this.#lost(), listenerOptions);
    channel.addEventListener("message", ({ data }) => this.#receive(data), listenerOptions);
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, host.signal);
    host.guard();
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Missing local SDP offer");
    const grant = await host.grant({ sdp });
    if (grant.kind !== "webrtc-answer") throw new Error("Session endpoint returned an invalid Live session");
    await peer.setRemoteDescription({ type: "answer", sdp: grant.answerSdp });
  }

  submitToolResult(result: RealtimeToolResult): void {
    const channel = this.#channel;
    if (channel?.readyState !== "open") throw new Error("Live data channel is not ready");
    if (!this.#tools.pending(result.callId)) throw new Error("Unknown or already submitted Live function call");
    try {
      channel.send(JSON.stringify({ type: "response.item.create", event_id: crypto.randomUUID(), item: {
        type: "function_call_output", call_id: result.callId, output: result.output,
      } }));
      if (this.#tools.submitted(result.callId)) channel.send(JSON.stringify({ type: "response.create", event_id: crypto.randomUUID() }));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#end(new Error(`Live tool result delivery failed: ${failure.message}`));
      throw failure;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const channel = this.#channel;
    if (channel?.readyState !== "open") {
      this.#end(new Error("Live finalization failed; final session usage is unconfirmed"));
      return Promise.resolve();
    }
    this.#microphone?.getTracks().forEach((track) => track.stop());
    this.#microphone = undefined;
    this.#closing = new Promise<void>((resolve) => { this.#finishClose = resolve; });
    this.#closeTimer = setTimeout(() => this.#end(new Error("Live finalization timed out; final session usage is unconfirmed")), 15_000);
    try {
      channel.send(JSON.stringify({ type: "session.close" }));
    } catch {
      this.#end(new Error("Live close failed; final session usage is unconfirmed"));
    }
    return this.#closing;
  }

  abort(reason: LiveChannelAbort): void {
    if (this.#released) return;
    this.#released = true;
    this.#events.abort();
    if (reason === "lease-lost") {
      try {
        if (this.#channel?.readyState === "open") this.#channel.send(JSON.stringify({ type: "session.close" }));
      } catch {}
    }
    this.#channel?.close();
    this.#peer?.close();
    this.#microphone?.getTracks().forEach((track) => track.stop());
    this.#channel = undefined;
    this.#peer = undefined;
    this.#microphone = undefined;
    this.#settle();
  }

  #receive(data: unknown): void {
    const host = this.#host;
    if (!host || this.#released || typeof data !== "string") return;
    try {
      const event: unknown = JSON.parse(data);
      const type = record(event)?.type;
      if (type === "session.started" && !this.#running) this.#running = host.started();
      for (const normalized of normalizeOpenAIEvent(event)) host.emit(normalized);
      for (const normalized of this.#tools.receive(event)) host.emit(normalized);
      if (type === "session.closed") {
        const usage = record(record(event)?.usage);
        if (typeof usage?.seconds !== "number" || !Number.isFinite(usage.seconds) || usage.seconds < 0) {
          this.#end(new Error("Live finalization ended without confirmed final usage"));
        } else if (!this.#running) {
          this.#end(new Error("Live session closed before startup"));
        } else {
          this.#end(undefined);
        }
      }
    } catch (error) {
      this.#end(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #lost(): void {
    if (this.#released) return;
    this.#host?.ended(new Error("Live connection lost; final session usage is unconfirmed"), this.#running);
  }

  #end(error: Error | undefined): void {
    this.#settle();
    this.#host?.ended(error, true);
  }

  #settle(): void {
    clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
    this.#finishClose?.();
    this.#finishClose = undefined;
  }
}
