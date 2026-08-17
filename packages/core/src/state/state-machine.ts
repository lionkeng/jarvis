import type { AgentState, StateSnapshot, VoiceSessionEvent } from "./types.js";

export function transitionState(snapshot: StateSnapshot, event: VoiceSessionEvent, now = performance.now()): StateSnapshot {
  let state: AgentState = snapshot.state;
  let error = snapshot.error;

  switch (event.type) {
    case "connect":
    case "connected":
    case "agent-audio-stopped":
    case "reset":
      state = "idle";
      error = undefined;
      break;
    case "user-speech-started":
      state = snapshot.state === "speaking" ? "interrupted" : "listening";
      break;
    case "user-speech-stopped":
      state = "thinking";
      break;
    case "agent-audio-started":
      state = "speaking";
      break;
    case "response-done":
      state = "idle";
      break;
    case "disconnect":
      state = "idle";
      error = undefined;
      break;
    case "fail":
      state = "error";
      error = event.error;
      break;
  }

  if (state === snapshot.state && error === snapshot.error) return snapshot;
  return error
    ? { state, previous: snapshot.state, changedAt: now, error }
    : { state, previous: snapshot.state, changedAt: now };
}

export class VoiceStateMachine {
  #snapshot: StateSnapshot = { state: "idle", previous: "idle", changedAt: 0 };

  get snapshot(): StateSnapshot {
    return this.#snapshot;
  }

  dispatch(event: VoiceSessionEvent, now?: number): StateSnapshot {
    this.#snapshot = transitionState(this.#snapshot, event, now);
    return this.#snapshot;
  }
}
