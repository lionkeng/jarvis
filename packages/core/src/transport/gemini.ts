import { PcmDuplex } from "../audio/pcm-duplex.js";
import type { WebsocketTokenGrant } from "./broker.js";
import { record } from "./live-events.js";
import type { LiveChannel, LiveChannelHost } from "./live-transport.js";
import type { NormalizedRealtimeEvent, RealtimeToolResult } from "./types.js";

const OPEN = 1;
const SETUP_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;

export class GeminiToolTurn {
  readonly #pending = new Map<string, string>();
  readonly #dropped = new Set<string>();

  receive(message: Record<string, unknown>): NormalizedRealtimeEvent[] {
    const listed: unknown[] = Array.isArray(message.functionCalls) ? message.functionCalls : [];
    const events: NormalizedRealtimeEvent[] = [];
    for (const entry of listed) {
      const call = record(entry);
      if (typeof call?.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) continue;
      if (this.#pending.has(call.id) || this.#dropped.has(call.id)) continue;
      this.#pending.set(call.id, call.name);
      events.push({ type: "tool-call", call: { callId: call.id, name: call.name, argumentsJson: JSON.stringify(call.args ?? {}) } });
    }
    return events;
  }

  drop(ids: unknown): void {
    const listed: unknown[] = Array.isArray(ids) ? ids : [];
    for (const id of listed) {
      if (typeof id !== "string") continue;
      this.#pending.delete(id);
      this.#dropped.add(id);
    }
  }

  clear(): void {
    for (const id of this.#pending.keys()) this.#dropped.add(id);
    this.#pending.clear();
  }

  dropped(callId: string): boolean { return this.#dropped.has(callId); }

  take(callId: string): string | undefined {
    const name = this.#pending.get(callId);
    if (name !== undefined) this.#pending.delete(callId);
    return name;
  }
}

export class GeminiLiveChannel implements LiveChannel {
  readonly #events = new AbortController();
  readonly #tools = new GeminiToolTurn();
  readonly #sockets = new Set<WebSocket>();
  readonly #dialing = new Map<WebSocket, { ready: () => void; failed: (error: Error) => void }>();
  #host: LiveChannelHost | undefined;
  #grant: WebsocketTokenGrant | undefined;
  #audio: PcmDuplex | undefined;
  #socket: WebSocket | undefined;
  #handle: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #heard = "";
  #spoke = false;
  #told = false;
  #released = false;
  #resuming = false;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;

  runnable(): boolean {
    return typeof WebSocket === "function" && typeof AudioContext === "function" && typeof AudioWorkletNode === "function"
      && typeof navigator !== "undefined" && navigator.mediaDevices !== undefined;
  }

  async open(host: LiveChannelHost): Promise<void> {
    this.#host = host;
    const grant = await host.grant();
    host.guard();
    if (grant.kind !== "websocket-token") throw new Error("Session endpoint returned an invalid Live session");
    this.#grant = grant;
    const audio = new PcmDuplex({ capture: (pcm16, rate) => this.#speak(pcm16, rate) });
    try {
      await audio.start();
      host.guard();
      if (this.#released) throw new Error("Live connection cancelled");
    } catch (error) {
      await audio.close();
      throw error;
    }
    this.#audio = audio;
    await this.#dial(undefined);
    host.guard();
    this.#expiry = setTimeout(() => this.#fail(new Error("Live session token expired; final session usage is unconfirmed")), Math.max(0, grant.expiresAt - Date.now()));
    host.emit({ type: "agent-track", stream: audio.stream, track: audio.track, continuous: true });
    host.started();
  }

  submitToolResult(result: RealtimeToolResult): void {
    if (this.#tools.dropped(result.callId)) return;
    if (this.#socket?.readyState !== OPEN) throw new Error("Live data channel is not ready");
    const name = this.#tools.take(result.callId);
    if (name === undefined) throw new Error("Unknown or already submitted Live function call");
    this.#send({ toolResponse: { functionResponses: [{ id: result.callId, name, response: toResponse(result.output) }] } });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = new Promise<void>((resolve) => { this.#finishClose = resolve; });
    void this.#audio?.close();
    this.#audio = undefined;
    const socket = this.#socket;
    for (const other of this.#sockets) if (other !== socket) shut(other);
    if (!socket || socket.readyState > OPEN) this.#settle();
    else {
      this.#closeTimer = setTimeout(() => this.#settle(), CLOSE_TIMEOUT_MS);
      shut(socket);
    }
    return this.#closing;
  }

  abort(): void {
    if (this.#released) return;
    this.#released = true;
    this.#events.abort();
    for (const dial of this.#dialing.values()) dial.failed(new Error("Live connection cancelled"));
    this.#dialing.clear();
    for (const socket of this.#sockets) shut(socket);
    this.#sockets.clear();
    this.#socket = undefined;
    void this.#audio?.close();
    this.#audio = undefined;
    this.#settle();
  }

  async #dial(handle: string | undefined): Promise<WebSocket> {
    const grant = this.#grant;
    if (!grant || this.#released) throw new Error("Live connection cancelled");
    const socket = new WebSocket(`${grant.endpoint}?access_token=${encodeURIComponent(grant.token)}`);
    socket.binaryType = "arraybuffer";
    this.#sockets.add(socket);
    let ready: () => void = () => undefined;
    let failed: (error: Error) => void = () => undefined;
    const opened = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    this.#dialing.set(socket, { ready, failed });
    const options = { signal: this.#events.signal };
    socket.addEventListener("open", () => {
      try { socket.send(JSON.stringify(setupFrame(grant.setup, handle))); }
      catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
    }, options);
    socket.addEventListener("message", (event) => this.#enqueue(socket, event.data), options);
    socket.addEventListener("error", () => failed(new Error("Live connection failed; final session usage is unconfirmed")), options);
    socket.addEventListener("close", (event) => {
      failed(new Error(lost("Live connection closed before setup", event.reason)));
      this.#closed(socket, event.code, event.reason);
    }, options);
    const timer = setTimeout(() => {
      failed(new Error("Live session setup timed out; final session usage is unconfirmed"));
      shut(socket);
    }, SETUP_TIMEOUT_MS);
    try {
      await opened;
    } finally {
      clearTimeout(timer);
      this.#dialing.delete(socket);
    }
    return socket;
  }

  #adopt(socket: WebSocket): void {
    const dial = this.#dialing.get(socket);
    if (!dial) return;
    if (this.#released || this.#closing) { shut(socket); return; }
    const previous = this.#socket;
    this.#socket = socket;
    if (previous && previous !== socket) {
      this.#sockets.delete(previous);
      shut(previous);
    }
    dial.ready();
  }

  #enqueue(socket: WebSocket, data: unknown): void {
    this.#queue = this.#queue.then(async () => {
      const text = await asText(data);
      try { this.#route(socket, text); }
      catch (error) { this.#host?.emit({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }); }
    }).catch(() => undefined);
  }

  #route(socket: WebSocket, text: string): void {
    const host = this.#host;
    if (!host || this.#released) return;
    let message: Record<string, unknown> | undefined;
    try { message = record(JSON.parse(text)); } catch { return; }
    if (!message) return;
    if (message.setupComplete !== undefined) { this.#adopt(socket); return; }
    if (socket !== this.#socket) return;
    const failure = record(message.error);
    if (failure) {
      this.#fail(new Error(typeof failure.message === "string" ? failure.message : "Live provider error"));
      return;
    }
    const resumption = record(message.sessionResumptionUpdate);
    if (resumption) this.#handle = resumption.resumable === true && typeof resumption.newHandle === "string" ? resumption.newHandle : undefined;
    const cancellation = record(message.toolCallCancellation);
    if (cancellation) this.#tools.drop(cancellation.ids);
    const content = record(message.serverContent);
    if (content) this.#content(host, content);
    const call = record(message.toolCall);
    if (call) {
      this.#flushHeard(host);
      for (const event of this.#tools.receive(call)) host.emit(event);
    }
    if (message.goAway !== undefined) this.#resume();
  }

  #content(host: LiveChannelHost, content: Record<string, unknown>): void {
    if (content.interrupted === true) {
      this.#audio?.flush();
      this.#tools.clear();
      this.#spoke = false;
      this.#told = false;
      host.emit({ type: "user-speech-started" });
    }
    const listened = record(content.inputTranscription);
    if (typeof listened?.text === "string") this.#heard += listened.text;
    const turn = record(content.modelTurn);
    const spoken = record(content.outputTranscription);
    if (turn || spoken) this.#flushHeard(host);
    if (turn) {
      const parts: unknown[] = Array.isArray(turn.parts) ? turn.parts : [];
      for (const entry of parts) {
        const inline = record(record(entry)?.inlineData);
        if (typeof inline?.data !== "string" || !inline.data) continue;
        this.#spoke = true;
        this.#audio?.play(fromBase64(inline.data));
      }
    }
    if (typeof spoken?.text === "string" && spoken.text) {
      this.#told = true;
      host.emit({ type: "agent-text-delta", delta: spoken.text, audioSynchronized: true });
    }
    if (content.turnComplete !== true) return;
    if (this.#told) host.emit({ type: "agent-text-done", audioSynchronized: true });
    if (this.#told || this.#spoke) host.emit({ type: "response-done" });
    this.#spoke = false;
    this.#told = false;
  }

  #flushHeard(host: LiveChannelHost): void {
    const text = this.#heard.trim();
    this.#heard = "";
    if (text) host.emit({ type: "user-text", text });
  }

  #resume(): void {
    if (this.#resuming || this.#released || this.#closing) return;
    this.#resuming = true;
    const handle = this.#handle;
    if (handle === undefined) {
      this.#fail(new Error("Live session ended without a resumable handle; final session usage is unconfirmed"));
      return;
    }
    void this.#dial(handle).then(
      () => { this.#resuming = false; },
      (error: unknown) => {
        this.#resuming = false;
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  #speak(pcm16: ArrayBuffer, sampleRate: number): void {
    this.#send({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${sampleRate}`, data: toBase64(pcm16) } } });
  }

  #send(message: Record<string, unknown>): void {
    const socket = this.#socket;
    if (this.#released || socket?.readyState !== OPEN) return;
    try { socket.send(JSON.stringify(message)); } catch {}
  }

  #closed(socket: WebSocket, code: number, reason: unknown): void {
    this.#sockets.delete(socket);
    if (this.#released || socket !== this.#socket) return;
    this.#socket = undefined;
    if (this.#closing) { this.#settle(); return; }
    if (this.#resuming) return;
    this.#fail(new Error(lost(`Live connection lost with code ${code}`, reason)));
  }

  #fail(error: Error): void {
    if (this.#released) return;
    this.#settle();
    this.#host?.ended(error, true);
  }

  #settle(): void {
    clearTimeout(this.#expiry);
    clearTimeout(this.#closeTimer);
    this.#expiry = undefined;
    this.#closeTimer = undefined;
    this.#finishClose?.();
    this.#finishClose = undefined;
  }
}

function setupFrame(setup: Record<string, unknown>, handle: string | undefined): Record<string, unknown> {
  if (handle === undefined) return setup;
  const inner = record(setup.setup) ?? {};
  const resumption = record(inner.sessionResumption) ?? {};
  return { ...setup, setup: { ...inner, sessionResumption: { ...resumption, handle } } };
}

function toResponse(output: string): Record<string, unknown> {
  try {
    const parsed = record(JSON.parse(output));
    if (parsed) return parsed;
  } catch {}
  return { result: output };
}

function toBase64(pcm16: ArrayBuffer): string {
  const view = new Uint8Array(pcm16);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const view = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) view[index] = binary.charCodeAt(index);
  return view.buffer;
}

async function asText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob === "function" && data instanceof Blob) return data.text();
  throw new Error("Live connection sent an unreadable frame");
}

function lost(prefix: string, reason: unknown): string {
  const stated = typeof reason === "string" ? reason.trim() : "";
  return `${prefix}${stated ? `: ${stated}` : ""}; final session usage is unconfirmed`;
}

function shut(socket: WebSocket): void {
  try { socket.close(1000); } catch {}
}
