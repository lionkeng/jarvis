export type ResponseTiming = "fast" | "natural" | "patient";

export interface RealtimeSessionPreferences {
  responseTiming?: ResponseTiming;
  speechRate?: number;
}

export interface RealtimeToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface RealtimeToolResult {
  callId: string;
  output: string;
}

export type NormalizedRealtimeEvent =
  | { type: "live-caption"; role: "user" | "agent"; delta: string; startMs: number; endMs: number }
  | { type: "backend-usage"; delegationId: string; responseId: string; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: "session-usage"; seconds: number; final: boolean; reason: string | undefined }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "user-speech-started" }
  | { type: "user-speech-stopped" }
  | { type: "user-text"; text: string }
  | { type: "agent-audio-started" }
  | { type: "agent-audio-stopped" }
  | { type: "agent-text-delta"; delta: string; audioSynchronized?: boolean }
  | { type: "agent-text-done"; text?: string; audioSynchronized?: boolean }
  | { type: "response-done" }
  | { type: "agent-track"; stream: MediaStream; track: MediaStreamTrack; continuous?: boolean }
  | { type: "tool-call"; call: RealtimeToolCall }
  | { type: "provider-error"; message: string; code: string | undefined; clientEventId: string | undefined }
  | { type: "backend-failed"; delegationId: string; responseId: string; status: "failed" | "incomplete" | "cancelled" }
  | { type: "error"; error: Error };

export type RealtimeEventListener = (event: NormalizedRealtimeEvent) => void;

export interface RealtimeTransport {
  readonly connected: boolean;
  readonly agentAudio: MediaStreamTrack | null;
  connect(tokenEndpoint: string, preferences?: RealtimeSessionPreferences): Promise<void>;
  disconnect(): void | Promise<void>;
  subscribe(listener: RealtimeEventListener): () => void;
  submitToolResult(result: RealtimeToolResult): void;
}
