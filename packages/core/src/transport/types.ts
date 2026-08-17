export interface EphemeralSession {
  value: string;
  expiresAt?: number;
}

export type ResponseTiming = "fast" | "natural" | "patient";

export interface RealtimeSessionPreferences {
  responseTiming?: ResponseTiming;
  speechRate?: number;
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
  | { type: "error"; error: Error };

export type RealtimeEventListener = (event: NormalizedRealtimeEvent) => void;

export interface RealtimeTransport {
  readonly connected: boolean;
  readonly agentAudio: MediaStreamTrack | null;
  connect(tokenEndpoint: string, preferences?: RealtimeSessionPreferences): Promise<void>;
  disconnect(): void;
  subscribe(listener: RealtimeEventListener): () => void;
}
