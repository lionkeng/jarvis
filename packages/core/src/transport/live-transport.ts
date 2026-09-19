import { BrokerLease, type LiveGrant, type LivePlan, type ProtocolId } from "./broker.js";
import { OpenAILiveChannel } from "./openai.js";
import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeSessionPreferences, RealtimeToolResult, RealtimeTransport } from "./types.js";

export type LiveChannelAbort = "lease-lost" | "released";

export interface LiveChannelHost {
  readonly preferences: RealtimeSessionPreferences;
  readonly signal: AbortSignal;
  guard(): void;
  grant(body?: Record<string, unknown>): Promise<LiveGrant>;
  emit(event: NormalizedRealtimeEvent): void;
  started(): boolean;
  ended(error: Error | undefined, announce: boolean): void;
}

export interface LiveChannel {
  runnable(): boolean;
  open(host: LiveChannelHost): Promise<void>;
  submitToolResult(result: RealtimeToolResult): void;
  close(): Promise<void>;
  abort(reason: LiveChannelAbort): void;
}

const CHANNELS = new Map<ProtocolId, () => LiveChannel>([["openai-live", () => new OpenAILiveChannel()]]);

type LivePhase = "starting" | "active" | "closing" | "closed";

interface LiveSession {
  phase: LivePhase;
  abort: AbortController;
  channel: LiveChannel | undefined;
  lease: BrokerLease | undefined;
  startup: Promise<void>;
  resolveStartup: () => void;
  rejectStartup: (error: Error) => void;
  agentAudio: MediaStreamTrack | null;
  startupTimer: ReturnType<typeof setTimeout> | undefined;
  closing: Promise<void> | undefined;
  finishClose: (() => void) | undefined;
}

export class LiveTransport implements RealtimeTransport {
  readonly #protocol: ProtocolId | undefined;
  #session: LiveSession | undefined;
  #connectRequest: object | undefined;
  #listeners = new Set<RealtimeEventListener>();

  constructor(options: { protocol?: ProtocolId } = {}) {
    this.#protocol = options.protocol;
  }

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
    const guard = () => { if (!requested()) throw new Error("Live connection cancelled"); };
    try {
      const lease = new BrokerLease({
        endpoint: sessionEndpoint,
        signal: session.abort.signal,
        guard,
        lost: (error) => this.#leaseLost(session, error),
      });
      session.lease = lease;
      const plan = await lease.open();
      guard();
      const [protocol, channel] = this.#select(plan);
      session.channel = channel;
      await channel.open({
        preferences,
        signal: session.abort.signal,
        guard,
        grant: (body) => lease.grant(protocol, preferences, body),
        emit: (event) => this.#receive(session, event),
        started: () => this.#started(session, requested),
        ended: (error, announce) => this.#terminate(session, error, announce),
      });
      session.startupTimer = setTimeout(() => session.rejectStartup(new Error("Live session startup timed out")), 20_000);
      await session.startup;
      guard();
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
    if (session?.phase !== "active" || !session.channel) throw new Error("Live data channel is not ready");
    session.channel.submitToolResult(result);
  }

  disconnect(): Promise<void> {
    this.#connectRequest = undefined;
    return this.#session ? this.#close(this.#session) : Promise.resolve();
  }

  #createSession(): LiveSession {
    let resolveStartup: () => void = () => undefined;
    let rejectStartup: (error: Error) => void = () => undefined;
    const startup = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
    void startup.catch(() => undefined);
    return {
      phase: "starting", abort: new AbortController(), channel: undefined, lease: undefined,
      startup, resolveStartup, rejectStartup, agentAudio: null,
      startupTimer: undefined, closing: undefined, finishClose: undefined,
    };
  }

  #select(plan: LivePlan): [ProtocolId, LiveChannel] {
    const pinned = this.#protocol;
    if (pinned !== undefined) {
      const create = plan.includes(pinned) ? CHANNELS.get(pinned) : undefined;
      if (!create) throw new Error(`Session broker does not offer the ${pinned} protocol`);
      return [pinned, create()];
    }
    for (const protocol of plan) {
      const channel = CHANNELS.get(protocol)?.();
      if (channel?.runnable()) return [protocol, channel];
    }
    throw new Error("No offered live protocol can run here");
  }

  #started(session: LiveSession, requested: () => boolean): boolean {
    if (this.#live(session) && session.phase === "starting") {
      if (!requested()) session.rejectStartup(new Error("Live connection cancelled"));
      else {
        session.phase = "active";
        this.#emit({ type: "connected" });
        if (!requested() || session.phase !== "active") session.rejectStartup(new Error("Live connection cancelled"));
        else session.resolveStartup();
      }
    }
    return session.phase !== "starting";
  }

  #receive(session: LiveSession, event: NormalizedRealtimeEvent): void {
    if (!this.#live(session)) return;
    if (event.type === "provider-error" && session.phase === "starting") {
      session.rejectStartup(new Error(event.message));
      return;
    }
    if (event.type === "tool-call" && session.phase !== "active") return;
    if (event.type === "agent-track") session.agentAudio = event.track;
    this.#emit(event);
  }

  #leaseLost(session: LiveSession, error: Error): void {
    if (!this.#live(session) || session.abort.signal.aborted) return;
    session.channel?.abort("lease-lost");
    this.#terminate(session, error, true);
  }

  #close(session: LiveSession): Promise<void> {
    if (session.phase === "closed") return Promise.resolve();
    if (session.closing) return session.closing;
    const channel = session.channel;
    if (session.phase !== "active" || !channel) {
      this.#terminate(session, undefined, true);
      return Promise.resolve();
    }
    session.phase = "closing";
    session.rejectStartup(new Error("Live connection cancelled"));
    session.closing = new Promise<void>((resolve) => { session.finishClose = resolve; });
    void channel.close().then(
      () => this.#terminate(session, undefined, true),
      (error: unknown) => this.#terminate(session, error instanceof Error ? error : new Error(String(error)), true),
    );
    return session.closing;
  }

  #terminate(session: LiveSession, error: Error | undefined, announce: boolean): void {
    if (!this.#release(session, error ?? new Error("Live connection cancelled"))) return;
    if (error) this.#emit({ type: "error", error });
    if (announce && !this.#session) this.#emit({ type: "disconnected" });
  }

  #release(session: LiveSession, startupError: Error): boolean {
    if (session.phase === "closed") return false;
    session.phase = "closed";
    clearTimeout(session.startupTimer);
    session.startupTimer = undefined;
    session.lease?.release();
    session.abort.abort();
    session.rejectStartup(startupError);
    session.channel?.abort("released");
    session.channel = undefined;
    session.agentAudio = null;
    if (this.#session === session) this.#session = undefined;
    session.finishClose?.();
    session.finishClose = undefined;
    return true;
  }

  #emit(event: NormalizedRealtimeEvent): void { for (const listener of this.#listeners) listener(event); }
}

export class OpenAILiveTransport extends LiveTransport {
  constructor() { super({ protocol: "openai-live" }); }
}

export function createLiveTransport(options: { protocol?: ProtocolId } = {}): RealtimeTransport {
  return new LiveTransport(options);
}
