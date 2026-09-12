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

  it("keeps overlapping Live speakers independent and incorporates late fragments", () => {
    const store = new TranscriptStore();
    const first = store.appendTimedDelta("agent", { delta: "Hello", startMs: 0, endMs: 200 }, 1);
    store.appendTimedDelta("user", { delta: "Wait", startMs: 100, endMs: 250 }, 2);
    store.appendTimedDelta("agent", { delta: " world", startMs: 200, endMs: 500 }, 3);
    store.appendTimedDelta("agent", { delta: "Again", startMs: 3000, endMs: 3200 }, 4);
    store.appendTimedDelta("agent", { delta: "!", startMs: 500, endMs: 600 }, 5);
    const rows = store.getSnapshot().messages;
    expect(rows.map((row) => row.text)).toEqual(["Hello world!", "Wait", "Again"]);
    expect(rows[0]?.id).toBe(first.id);
    expect(rows[0]?.fragments).toHaveLength(3);
    expect(rows.map((row) => row.status)).toEqual(["complete", "streaming", "streaming"]);
    store.beginTimedSession();
    expect(store.getSnapshot().messages.every((row) => row.status === "complete")).toBe(true);
    expect(rows[1]?.fragments?.[0]).toEqual({ delta: "Wait", startMs: 100, endMs: 250 });
  });

  it("keeps reset session timestamps from changing the previous conversation", () => {
    const store = new TranscriptStore();
    store.appendTimedDelta("user", { delta: "First", startMs: 0, endMs: 100 });
    store.beginTimedSession();
    store.appendTimedDelta("user", { delta: "Second", startMs: 0, endMs: 100 });
    expect(store.getSnapshot().messages.map((row) => row.text)).toEqual(["First", "Second"]);
    store.clear();
    store.appendTimedDelta("user", { delta: "New", startMs: 0, endMs: 100 });
    store.appendTimedDelta("user", { delta: " session", startMs: 100, endMs: 200 });
    expect(store.getSnapshot().messages.map((row) => row.text)).toEqual(["New session"]);
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
