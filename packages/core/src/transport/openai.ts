import { LiveToolBatches, normalizeOpenAIEvent, record } from "./live-events.js";
import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeSessionPreferences, RealtimeToolResult, RealtimeTransport } from "./types.js";
export { normalizeOpenAIEvent } from "./live-events.js";

export function parseLiveSession(value: unknown): { id: string; sdp: string } {
  const payload = record(value);
  const session = record(payload?.session);
  const transport = record(payload?.transport);
  if (typeof session?.id !== "string" || !session.id.trim() || transport?.type !== "webrtc"
    || typeof transport.sdp !== "string" || !transport.sdp.trim()) throw new Error("Session endpoint returned an invalid Live session");
  return { id: session.id, sdp: transport.sdp };
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

type LiveSessionPhase = "starting" | "active" | "closing" | "closed";

interface LiveSession {
  phase: LiveSessionPhase;
  peer: RTCPeerConnection;
  abort: AbortController;
  tools: LiveToolBatches;
  startup: Promise<void>;
  resolveStartup: () => void;
  rejectStartup: (error: Error) => void;
  channel: RTCDataChannel | undefined;
  microphone: MediaStream | undefined;
  agentAudio: MediaStreamTrack | null;
  startupTimer: ReturnType<typeof setTimeout> | undefined;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  leaseDeadline: ReturnType<typeof setTimeout> | undefined;
  closing: Promise<void> | undefined;
  finishClose: (() => void) | undefined;
}

export class OpenAILiveTransport implements RealtimeTransport {
  #session: LiveSession | undefined;
  #connectRequest: object | undefined;
  #listeners = new Set<RealtimeEventListener>();

  get connected(): boolean { return this.#session?.phase === "active"; }
  get agentAudio(): MediaStreamTrack | null { return this.#session?.agentAudio ?? null; }

  #live(session: LiveSession): boolean { return this.#session === session; }

  subscribe(listener: RealtimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(sessionEndpoint: string, preferences: RealtimeSessionPreferences = {}): Promise<void> {
    const request = {};
    this.#connectRequest = request;
    const previous = this.#session;
    if (previous) await this.#close(previous);
    if (this.#connectRequest !== request) throw new Error("Live connection cancelled");

    const session = this.#createSession();
    this.#session = session;
    const requested = () => this.#live(session) && this.#connectRequest === request;
    const ensureRequested = () => { if (!requested()) throw new Error("Live connection cancelled"); };
    const lost = () => {
      if (!this.#live(session)) return;
      this.#terminate(session, new Error("Live connection lost; final session usage is unconfirmed"), session.phase !== "starting");
    };
    const listenerOptions = { signal: session.abort.signal };
    try {
      session.peer.addEventListener("connectionstatechange", () => {
        if (["closed", "disconnected", "failed"].includes(session.peer.connectionState)) lost();
      }, listenerOptions);
      session.peer.addEventListener("track", ({ track, streams }) => {
        if (!this.#live(session) || track.kind !== "audio") return;
        session.agentAudio = track;
        this.#emit({ type: "agent-track", stream: streams[0] ?? new MediaStream([track]), track, continuous: true });
      }, listenerOptions);
      await this.#openBrokerLease(session, sessionEndpoint);
      ensureRequested();
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!requested() || session.phase !== "starting") {
        microphone.getTracks().forEach((track) => track.stop());
        ensureRequested();
      }
      session.microphone = microphone;
      for (const track of microphone.getTracks()) session.peer.addTrack(track, microphone);
      const channel = session.peer.createDataChannel("oai-events");
      session.channel = channel;
      channel.addEventListener("close", lost, listenerOptions);
      channel.addEventListener("error", lost, listenerOptions);
      channel.addEventListener("message", ({ data }) => {
        if (!this.#live(session) || typeof data !== "string") return;
        try {
          const event: unknown = JSON.parse(data);
          const type = record(event)?.type;
          if (type === "session.started" && session.phase === "starting") {
            if (!requested()) {
              session.rejectStartup(new Error("Live connection cancelled"));
              return;
            }
            session.phase = "active";
            this.#emit({ type: "connected" });
            if (!requested() || session.phase !== "active") {
              session.rejectStartup(new Error("Live connection cancelled"));
              return;
            }
            session.resolveStartup();
          }
          for (const normalized of normalizeOpenAIEvent(event)) {
            if (normalized.type === "provider-error" && session.phase === "starting") session.rejectStartup(new Error(normalized.message));
            else this.#emit(normalized);
          }
          for (const normalized of session.tools.receive(event)) {
            if (!this.#live(session)) break;
            if (normalized.type === "tool-call" && session.phase !== "active") continue;
            this.#emit(normalized);
          }
          if (type === "session.closed") {
            const usage = record(record(event)?.usage);
            if (typeof usage?.seconds !== "number" || !Number.isFinite(usage.seconds) || usage.seconds < 0) {
              this.#terminate(session, new Error("Live finalization ended without confirmed final usage"), true);
            } else if (session.phase === "starting") {
              this.#terminate(session, new Error("Live session closed before startup"), true);
            } else {
              this.#terminate(session, undefined, true);
            }
          }
        } catch (error) {
          this.#emit({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
        }
      }, listenerOptions);
      await session.peer.setLocalDescription(await session.peer.createOffer());
      await waitForIce(session.peer, session.abort.signal);
      ensureRequested();
      const sdp = session.peer.localDescription?.sdp;
      if (!sdp) throw new Error("Missing local SDP offer");
      const response = await fetch(sessionEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ...preferences, sdp }),
        signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(25_000)]),
      });
      if (!response.ok) throw new Error(`Session endpoint failed with ${response.status}`);
      const liveSession = parseLiveSession(await response.json());
      ensureRequested();
      await session.peer.setRemoteDescription({ type: "answer", sdp: liveSession.sdp });
      session.startupTimer = setTimeout(() => session.rejectStartup(new Error("Live session startup timed out")), 20_000);
      await session.startup;
      ensureRequested();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (session.phase !== "closed" && session.phase !== "closing") {
        this.#release(session, failure);
        this.#emit({ type: "error", error: failure });
      }
      throw failure;
    } finally {
      clearTimeout(session.startupTimer);
      session.startupTimer = undefined;
    }
  }

  submitToolResult(result: RealtimeToolResult): void {
    const session = this.#session;
    const channel = session?.channel;
    if (session?.phase !== "active" || channel?.readyState !== "open") throw new Error("Live data channel is not ready");
    if (!session.tools.pending(result.callId)) throw new Error("Unknown or already submitted Live function call");
    try {
      channel.send(JSON.stringify({ type: "response.item.create", event_id: crypto.randomUUID(), item: {
        type: "function_call_output", call_id: result.callId, output: result.output,
      } }));
      if (session.tools.submitted(result.callId)) channel.send(JSON.stringify({ type: "response.create", event_id: crypto.randomUUID() }));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#terminate(session, new Error(`Live tool result delivery failed: ${failure.message}`), true);
      throw failure;
    }
  }

  disconnect(): Promise<void> {
    this.#connectRequest = undefined;
    return this.#session ? this.#close(this.#session) : Promise.resolve();
  }

  #createSession(): LiveSession {
    const peer = new RTCPeerConnection();
    let resolveStartup: () => void = () => undefined;
    let rejectStartup: (error: Error) => void = () => undefined;
    const startup = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
    void startup.catch(() => undefined);
    return {
      phase: "starting", peer, abort: new AbortController(), tools: new LiveToolBatches(), startup,
      resolveStartup, rejectStartup, channel: undefined, microphone: undefined, agentAudio: null,
      startupTimer: undefined, closeTimer: undefined, leaseDeadline: undefined, closing: undefined, finishClose: undefined,
    };
  }

  async #openBrokerLease(session: LiveSession, sessionEndpoint: string): Promise<void> {
    this.#resetLeaseDeadline(session);
    let response: Response;
    try {
      response = await fetch(sessionEndpoint, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        credentials: "omit",
        signal: session.abort.signal,
      });
    } catch (error) {
      if (session.abort.signal.aborted) throw error;
      throw this.#brokerError(error);
    }
    if (!response.ok) throw new Error(`Session broker lease failed with ${response.status}`);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new Error("Session broker lease returned an invalid content type");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Session broker lease returned no stream");
    const decoder = new TextDecoder();
    let ready = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Session broker lease ended before ready");
        if (chunk.value.byteLength === 0) continue;
        this.#resetLeaseDeadline(session);
        ready += decoder.decode(chunk.value, { stream: true });
        if (ready.includes("event: ready")) break;
        if (ready.length > 4_096) throw new Error("Session broker lease did not become ready");
      }
    } catch (error) {
      if (session.abort.signal.aborted) throw error;
      throw this.#brokerError(error);
    }
    void this.#readBrokerLease(session, reader);
  }

  async #readBrokerLease(session: LiveSession, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Session broker disconnected; final session usage is unconfirmed");
        if (chunk.value.byteLength > 0) this.#resetLeaseDeadline(session);
      }
    } catch (error) {
      if (session.abort.signal.aborted || !this.#live(session)) return;
      this.#brokerDisconnected(session, this.#brokerError(error));
    }
  }

  #resetLeaseDeadline(session: LiveSession): void {
    if (!this.#live(session)) return;
    clearTimeout(session.leaseDeadline);
    session.leaseDeadline = setTimeout(() => {
      this.#brokerDisconnected(session, new Error("Session broker heartbeat timed out; final session usage is unconfirmed"));
    }, 15_000);
  }

  #brokerDisconnected(session: LiveSession, error: Error): void {
    if (!this.#live(session) || session.abort.signal.aborted) return;
    try {
      if (session.channel?.readyState === "open") session.channel.send(JSON.stringify({ type: "session.close" }));
    } catch {}
    this.#terminate(session, error, true);
  }

  #brokerError(cause: unknown): Error {
    return new Error("Session broker disconnected; final session usage is unconfirmed", { cause });
  }

  #close(session: LiveSession): Promise<void> {
    if (session.phase === "closed") return Promise.resolve();
    if (session.closing) return session.closing;
    if (session.phase !== "active") {
      this.#terminate(session, undefined, true);
      return Promise.resolve();
    }
    if (session.channel?.readyState !== "open") {
      this.#terminate(session, new Error("Live finalization failed; final session usage is unconfirmed"), true);
      return Promise.resolve();
    }
    session.phase = "closing";
    session.microphone?.getTracks().forEach((track) => track.stop());
    session.microphone = undefined;
    session.rejectStartup(new Error("Live connection cancelled"));
    session.closing = new Promise<void>((resolve) => { session.finishClose = resolve; });
    session.closeTimer = setTimeout(() => {
      this.#terminate(session, new Error("Live finalization timed out; final session usage is unconfirmed"), true);
    }, 15_000);
    try {
      session.channel.send(JSON.stringify({ type: "session.close" }));
    } catch {
      this.#terminate(session, new Error("Live close failed; final session usage is unconfirmed"), true);
    }
    return session.closing;
  }

  #terminate(session: LiveSession, error: Error | undefined, disconnected: boolean): void {
    if (!this.#release(session, error ?? new Error("Live connection cancelled"))) return;
    if (error) this.#emit({ type: "error", error });
    if (disconnected && !this.#session) this.#emit({ type: "disconnected" });
  }

  #release(session: LiveSession, startupError: Error): boolean {
    if (session.phase === "closed") return false;
    session.phase = "closed";
    clearTimeout(session.startupTimer);
    clearTimeout(session.closeTimer);
    clearTimeout(session.leaseDeadline);
    session.startupTimer = undefined;
    session.closeTimer = undefined;
    session.leaseDeadline = undefined;
    session.abort.abort();
    session.rejectStartup(startupError);
    session.channel?.close();
    session.peer.close();
    session.microphone?.getTracks().forEach((track) => track.stop());
    session.channel = undefined;
    session.microphone = undefined;
    session.agentAudio = null;
    if (this.#session === session) this.#session = undefined;
    session.finishClose?.();
    session.finishClose = undefined;
    return true;
  }

  #emit(event: NormalizedRealtimeEvent): void { for (const listener of this.#listeners) listener(event); }
}
