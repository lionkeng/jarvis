export interface EphemeralSession {
  value: string;
  expiresAt?: number;
}

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

/**
 * Semantic follow-up after a tool result.
 * `default` requests a normal explanatory follow-up.
 * `brief-acknowledgement` requests a short success acknowledgement.
 * `none` submits the output and does not request a follow-up.
 */
export type RealtimeToolFollowUpIntent = "default" | "brief-acknowledgement" | "none";

export interface RealtimeToolResult {
  callId: string;
  output: string;
  followUp: RealtimeToolFollowUpIntent;
}

export type NormalizedRealtimeEvent =
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
  | { type: "agent-track"; stream: MediaStream; track: MediaStreamTrack }
  | { type: "tool-call"; call: RealtimeToolCall }
  | { type: "error"; error: Error };

export type RealtimeEventListener = (event: NormalizedRealtimeEvent) => void;

export interface RealtimeTransport {
  readonly connected: boolean;
  readonly agentAudio: MediaStreamTrack | null;
  connect(tokenEndpoint: string, preferences?: RealtimeSessionPreferences): Promise<void>;
  disconnect(): void;
  subscribe(listener: RealtimeEventListener): () => void;
  submitToolResult(result: RealtimeToolResult): void;
}
