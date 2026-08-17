export type AgentState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export type VoiceSessionEvent =
  | { type: "connect" }
  | { type: "connected" }
  | { type: "user-speech-started" }
  | { type: "user-speech-stopped" }
  | { type: "agent-audio-started" }
  | { type: "agent-audio-stopped" }
  | { type: "response-done" }
  | { type: "disconnect" }
  | { type: "fail"; error: Error }
  | { type: "reset" };

export interface StateSnapshot {
  state: AgentState;
  previous: AgentState;
  changedAt: number;
  error?: Error;
}
