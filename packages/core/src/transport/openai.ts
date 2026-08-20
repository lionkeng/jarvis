import type { EphemeralSession, NormalizedRealtimeEvent, RealtimeEventListener, RealtimeSessionPreferences, RealtimeToolResult, RealtimeTransport } from "./types.js";

type ProviderEvent = Record<string, unknown> & { type?: string };

function stringField(event: ProviderEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

export function normalizeOpenAIEvent(event: ProviderEvent): NormalizedRealtimeEvent[] {
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      return [{ type: "user-speech-started" }];
    case "input_audio_buffer.speech_stopped":
      return [{ type: "user-speech-stopped" }];
    case "conversation.item.input_audio_transcription.completed": {
      const text = stringField(event, "transcript") ?? stringField(event, "text");
      return text ? [{ type: "user-text", text }] : [];
    }
    case "response.output_audio.started":
    case "response.audio.started":
      return [{ type: "agent-audio-started" }];
    case "response.output_audio.done":
    case "response.audio.done":
      return [];
    case "response.output_audio.delta":
    case "response.audio.delta":
      return [{ type: "agent-audio-started" }];
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta": {
      const delta = stringField(event, "delta");
      return delta ? [{ type: "agent-audio-started" }, { type: "agent-text-delta", delta, audioSynchronized: true }] : [];
    }
    case "response.output_text.delta":
    case "response.text.delta": {
      const delta = stringField(event, "delta");
      return delta ? [{ type: "agent-text-delta", delta }] : [];
    }
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done": {
      const text = stringField(event, "transcript") ?? stringField(event, "text");
      return text ? [{ type: "agent-text-done", text, audioSynchronized: true }] : [{ type: "agent-text-done", audioSynchronized: true }];
    }
    case "response.output_text.done":
    case "response.text.done": {
      const text = stringField(event, "transcript") ?? stringField(event, "text");
      return text ? [{ type: "agent-text-done", text }] : [{ type: "agent-text-done" }];
    }
    case "response.done":
      return [{ type: "response-done" }, { type: "agent-audio-stopped" }];
    case "response.function_call_arguments.done": {
      const callId = stringField(event, "call_id");
      const name = stringField(event, "name");
      const argumentsJson = stringField(event, "arguments");
      if (!callId || !name || argumentsJson === undefined) return [];
      return [{ type: "tool-call", call: { callId, name, argumentsJson } }];
    }
    case "error": {
      const providerError = event.error;
      const message = typeof providerError === "object" && providerError && "message" in providerError
        ? String(providerError.message)
        : stringField(event, "message") ?? "Realtime provider error";
      return [{ type: "error", error: new Error(message) }];
    }
    default:
      return [];
  }
}

export function parseEphemeralSession(value: unknown, now = Date.now()): EphemeralSession {
  if (!value || typeof value !== "object") throw new Error("Session endpoint returned an invalid payload");
  const payload = value as Record<string, unknown>;
  const nested = payload.client_secret && typeof payload.client_secret === "object" ? payload.client_secret as Record<string, unknown> : undefined;
  const token = typeof payload.value === "string" ? payload.value : typeof nested?.value === "string" ? nested.value : undefined;
  if (!token) throw new Error("Session endpoint did not return an ephemeral client secret");
  const expires = typeof payload.expires_at === "number" ? payload.expires_at : typeof nested?.expires_at === "number" ? nested.expires_at : undefined;
  if (expires !== undefined && expires <= Math.floor(now / 1_000)) throw new Error("Session endpoint returned an expired client secret");
  return expires === undefined ? { value: token } : { value: token, expiresAt: expires };
}

export class OpenAIRealtimeTransport implements RealtimeTransport {
  #peer: RTCPeerConnection | undefined;
  #dataChannel: RTCDataChannel | undefined;
  #localStream: MediaStream | undefined;
  #listeners = new Set<RealtimeEventListener>();
  #connected = false;
  #audioStarted = false;
  #agentAudio: MediaStreamTrack | null = null;

  get connected(): boolean {
    return this.#connected;
  }

  get agentAudio(): MediaStreamTrack | null {
    return this.#agentAudio;
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(tokenEndpoint: string, preferences: RealtimeSessionPreferences = {}): Promise<void> {
    if (this.#peer) this.disconnect();
    try {
      const tokenResponse = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      if (!tokenResponse.ok) throw new Error(`Session endpoint failed with ${tokenResponse.status}`);
      const session = parseEphemeralSession(await tokenResponse.json());

      const peer = new RTCPeerConnection();
      this.#peer = peer;
      let resolveConnection: (() => void) | undefined;
      let rejectConnection: ((error: Error) => void) | undefined;
      const connectionReady = new Promise<void>((resolve, reject) => {
        resolveConnection = resolve;
        rejectConnection = reject;
      });
      void connectionReady.catch(() => undefined);
      const markConnected = () => {
        if (this.#peer !== peer || this.#connected) return;
        this.#connected = true;
        this.#emit({ type: "connected" });
        resolveConnection?.();
      };
      const rejectBeforeConnected = (state: string) => {
        if (this.#peer !== peer || this.#connected) return;
        rejectConnection?.(new Error(`Realtime peer connection ${state}`));
      };
      peer.addEventListener("connectionstatechange", () => {
        if (this.#peer !== peer) return;
        if (peer.connectionState === "connected") {
          markConnected();
        } else if (["closed", "disconnected", "failed"].includes(peer.connectionState)) {
          if (!this.#connected) {
            rejectBeforeConnected(peer.connectionState);
            return;
          }
          const hadResources = this.#teardown();
          if (!hadResources) return;
          this.#emit({ type: "disconnected" });
        }
      });
      peer.addEventListener("iceconnectionstatechange", () => {
        if (["connected", "completed"].includes(peer.iceConnectionState)) markConnected();
        else if (["closed", "disconnected", "failed"].includes(peer.iceConnectionState)) rejectBeforeConnected(`ICE ${peer.iceConnectionState}`);
      });
      peer.addEventListener("track", ({ track, streams }) => {
        this.#agentAudio = track;
        track.addEventListener("ended", () => {
          if (this.#agentAudio !== track) return;
          this.#agentAudio = null;
          this.#audioStarted = false;
          this.#emit({ type: "agent-audio-stopped" });
        }, { once: true });
        const stream = streams[0] ?? new MediaStream([track]);
        this.#emit({ type: "agent-track", stream, track });
      });

      this.#localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      for (const track of this.#localStream.getTracks()) peer.addTrack(track, this.#localStream);

      const channel = peer.createDataChannel("oai-events");
      this.#dataChannel = channel;
      channel.addEventListener("open", markConnected);
      channel.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") return;
        try {
          const event = JSON.parse(data) as ProviderEvent;
          for (const normalized of normalizeOpenAIEvent(event)) {
            if (normalized.type === "agent-audio-started") {
              if (this.#audioStarted) continue;
              this.#audioStarted = true;
            }
            if (normalized.type === "agent-audio-stopped") this.#audioStarted = false;
            this.#emit(normalized);
          }
        } catch (error) {
          this.#emit({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
        }
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const callResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.value}`, "Content-Type": "application/sdp" },
        body: offer.sdp ?? "",
      });
      if (!callResponse.ok) throw new Error(`Realtime call setup failed with status ${callResponse.status}`);
      await peer.setRemoteDescription({ type: "answer", sdp: await callResponse.text() });
      if (peer.connectionState === "connected" || ["connected", "completed"].includes(peer.iceConnectionState) || channel.readyState === "open") markConnected();
      let connectionTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connectionReady,
          new Promise<never>((_, reject) => {
            connectionTimer = setTimeout(() => reject(new Error("Realtime peer connection timed out")), 20_000);
          }),
        ]);
      } finally {
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.#teardown();
      this.#emit({ type: "error", error: normalized });
      throw normalized;
    }
  }

  submitToolResult(result: RealtimeToolResult): void {
    const channel = this.#dataChannel;
    if (!channel || channel.readyState !== "open") {
      throw new Error("Realtime data channel is not open");
    }
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: result.callId,
        output: result.output,
      },
    }));
    if (result.continueResponse !== false) {
      channel.send(JSON.stringify({ type: "response.create" }));
    }
  }

  disconnect(): void {
    if (this.#teardown()) this.#emit({ type: "disconnected" });
  }

  #teardown(): boolean {
    const hadResources = this.#connected || Boolean(this.#dataChannel || this.#peer || this.#localStream || this.#agentAudio);
    this.#connected = false;
    this.#audioStarted = false;
    this.#agentAudio = null;
    const dataChannel = this.#dataChannel;
    const peer = this.#peer;
    const localStream = this.#localStream;
    this.#dataChannel = undefined;
    this.#peer = undefined;
    this.#localStream = undefined;
    dataChannel?.close();
    peer?.close();
    for (const track of localStream?.getTracks() ?? []) track.stop();
    return hadResources;
  }

  #emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
