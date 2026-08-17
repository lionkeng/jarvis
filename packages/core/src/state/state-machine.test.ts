import { describe, expect, it } from "vitest";
import { transitionState } from "./state-machine.js";
import type { StateSnapshot, VoiceSessionEvent } from "./types.js";

function run(events: VoiceSessionEvent[]) {
  return events.reduce<StateSnapshot>((state, event, index) => transitionState(state, event, index + 1), {
    state: "idle",
    previous: "idle",
    changedAt: 0,
  });
}

describe("voice state machine", () => {
  it("tracks the normal turn lifecycle", () => {
    let snapshot = run([{ type: "connected" }]);
    snapshot = transitionState(snapshot, { type: "user-speech-started" }, 2);
    expect(snapshot.state).toBe("listening");
    snapshot = transitionState(snapshot, { type: "user-speech-stopped" }, 3);
    expect(snapshot.state).toBe("thinking");
    snapshot = transitionState(snapshot, { type: "agent-audio-started" }, 4);
    expect(snapshot.state).toBe("speaking");
    snapshot = transitionState(snapshot, { type: "response-done" }, 5);
    expect(snapshot.state).toBe("idle");
  });

  it("makes interruption explicit", () => {
    expect(run([{ type: "agent-audio-started" }, { type: "user-speech-started" }]).state).toBe("interrupted");
  });

  it("uses the normalized remote-audio stop as the silence fallback", () => {
    expect(run([{ type: "agent-audio-started" }, { type: "agent-audio-stopped" }]).state).toBe("idle");
  });

  it("retains provider errors until reset", () => {
    const error = new Error("network");
    const failed = run([{ type: "fail", error }]);
    expect(failed).toMatchObject({ state: "error", error });
    expect(transitionState(failed, { type: "reset" }).error).toBeUndefined();
  });
});
