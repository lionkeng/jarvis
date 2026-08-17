import { describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "./store.js";

describe("TranscriptStore", () => {
  it("streams deltas into a stable message", () => {
    const store = new TranscriptStore();
    const first = store.appendDelta("agent", "Hel", 1);
    const second = store.appendDelta("agent", "lo", 2);
    expect(second.id).toBe(first.id);
    expect(store.getSnapshot().messages[0]?.text).toBe("Hello");
    store.complete("agent", "complete", 3);
    expect(store.getSnapshot().messages[0]?.status).toBe("complete");
  });

  it("preserves interleaved user and agent messages", () => {
    const store = new TranscriptStore();
    store.appendMessage("user", "Hi", 1);
    store.appendDelta("agent", "Hello", 2);
    store.complete("agent", "interrupted", 3);
    store.appendMessage("user", "Wait", 4);
    expect(store.getSnapshot().messages.map(({ role, status }) => [role, status])).toEqual([
      ["user", "complete"], ["agent", "interrupted"], ["user", "complete"],
    ]);
  });

  it("notifies subscribers and can clear ephemeral history", () => {
    const store = new TranscriptStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.appendMessage("user", "temporary");
    store.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().messages).toEqual([]);
  });
});
