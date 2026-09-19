import { record } from "./live-events.js";
import type { RealtimeSessionPreferences } from "./types.js";

export type ProtocolId = "openai-live";
export type LivePlan = readonly [ProtocolId, ...ProtocolId[]];
export interface LiveGrant {
  kind: "webrtc-answer";
  sessionId: string;
  answerSdp: string;
}

const PROTOCOLS: readonly string[] = ["openai-live"];

export function parsePlan(value: unknown): LivePlan {
  const payload = record(value);
  if (!payload) throw new Error("Session broker lease returned an invalid ready payload");
  if (payload.protocols === undefined) return ["openai-live"];
  const listed: unknown[] = Array.isArray(payload.protocols) ? payload.protocols : [];
  const [first, ...rest] = listed.filter((id): id is ProtocolId => typeof id === "string" && PROTOCOLS.includes(id));
  if (!first) throw new Error("Session broker offered no usable live protocol");
  return [first, ...rest];
}

export function parseGrant(value: unknown): LiveGrant {
  const payload = record(value);
  const session = record(payload?.session);
  const transport = record(payload?.transport);
  if (typeof session?.id !== "string" || !session.id.trim() || transport?.type !== "webrtc"
    || typeof transport.sdp !== "string" || !transport.sdp.trim()) throw new Error("Session endpoint returned an invalid Live session");
  return { kind: "webrtc-answer", sessionId: session.id, answerSdp: transport.sdp };
}

export interface BrokerLeaseOptions {
  endpoint: string;
  signal: AbortSignal;
  guard: () => void;
  lost: (error: Error) => void;
}

export class BrokerLease {
  readonly #endpoint: string;
  readonly #signal: AbortSignal;
  readonly #guard: () => void;
  readonly #lost: (error: Error) => void;
  #legacy = true;
  #released = false;
  #deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BrokerLeaseOptions) {
    this.#endpoint = options.endpoint;
    this.#signal = options.signal;
    this.#guard = options.guard;
    this.#lost = options.lost;
  }

  async open(): Promise<LivePlan> {
    this.#extend();
    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        credentials: "omit",
        signal: this.#signal,
      });
    } catch (error) {
      if (this.#signal.aborted) throw error;
      throw brokerError(error);
    }
    if (!response.ok) throw new Error(`Session broker lease failed with ${response.status}`);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new Error("Session broker lease returned an invalid content type");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Session broker lease returned no stream");
    const decoder = new TextDecoder();
    let ready = "";
    let payload: string | undefined;
    try {
      while (payload === undefined) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Session broker lease ended before ready");
        if (chunk.value.byteLength === 0) continue;
        this.#extend();
        ready += decoder.decode(chunk.value, { stream: true });
        payload = readyPayload(ready);
        if (payload === undefined && ready.length > 4_096) throw new Error("Session broker lease did not become ready");
      }
    } catch (error) {
      if (this.#signal.aborted) throw error;
      throw brokerError(error);
    }
    const announced = parseReady(payload);
    const plan = parsePlan(announced);
    this.#legacy = record(announced)?.protocols === undefined;
    void this.#read(reader);
    return plan;
  }

  async grant(protocol: ProtocolId, preferences: RealtimeSessionPreferences, body?: Record<string, unknown>): Promise<LiveGrant> {
    this.#guard();
    const payload = this.#legacy ? { ...preferences, ...body } : { protocol, ...preferences, ...body };
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([this.#signal, AbortSignal.timeout(25_000)]),
    });
    if (!response.ok) throw new Error(`Session endpoint failed with ${response.status}`);
    const grant = parseGrant(await response.json());
    this.#guard();
    return grant;
  }

  release(): void {
    this.#released = true;
    clearTimeout(this.#deadline);
    this.#deadline = undefined;
  }

  async #read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Session broker disconnected; final session usage is unconfirmed");
        if (chunk.value.byteLength > 0) this.#extend();
      }
    } catch (error) {
      if (this.#signal.aborted || this.#released) return;
      this.#lost(brokerError(error));
    }
  }

  #extend(): void {
    if (this.#released) return;
    clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => {
      if (!this.#released) this.#lost(new Error("Session broker heartbeat timed out; final session usage is unconfirmed"));
    }, 15_000);
  }
}

function brokerError(cause: unknown): Error {
  return new Error("Session broker disconnected; final session usage is unconfirmed", { cause });
}

function readyPayload(buffer: string): string | undefined {
  const text = buffer.replace(/\r\n/g, "\n");
  let index = 0;
  while (true) {
    const end = text.indexOf("\n\n", index);
    if (end < 0) return undefined;
    const block = text.slice(index, end);
    index = end + 2;
    if (!block.includes("event: ready")) continue;
    return block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.replace(/^data: ?/, "")).join("\n");
  }
}

function parseReady(payload: string): unknown {
  if (!payload.trim()) return {};
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Session broker lease returned an invalid ready payload");
  }
}
