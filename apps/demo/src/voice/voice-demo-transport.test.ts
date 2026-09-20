// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedRealtimeEvent } from "@jarvis-viz/core";
import { VoiceDemoTransport } from "./voice-demo-transport.js";

afterEach(() => {
  vi.useRealTimers();
});

function toolCallFrom(events: NormalizedRealtimeEvent[]) {
  const toolCall = events.find((event) => event.type === "tool-call");
  expect(toolCall?.type).toBe("tool-call");
  if (toolCall?.type !== "tool-call") throw new Error("expected tool-call");
  return toolCall.call;
}

describe("VoiceDemoTransport", () => {
  it("plays the unqualified navigate-scroll script with a downward article scroll", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("navigate-scroll");
    await vi.advanceTimersByTimeAsync(200);
    const call = toolCallFrom(events);
    expect(events.some((event) => event.type === "user-text" && event.text === "Open article and scroll")).toBe(true);
    expect(call.name).toBe("perform_ui_actions");
    expect(JSON.parse(call.argumentsJson)).toEqual({
      actions: [
        { type: "navigate", target: "article" },
        { type: "scroll", target: "article.content", direction: "down" },
      ],
    });
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({ ok: true, message: "Opened the article and scrolled down." }),
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "Opened the article and scrolled down.")).toBe(true);
    expect(events.some((event) => event.type === "response-done")).toBe(true);
    expect(transport.submittedToolResults).toHaveLength(1);
    transport.disconnect();
  });

  it("plays the explicit bottom script with a bottom article scroll", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("navigate-scroll-bottom");
    await vi.advanceTimersByTimeAsync(200);
    const call = toolCallFrom(events);
    expect(events.some((event) => event.type === "user-text" && event.text === "Open the article and scroll to the bottom")).toBe(true);
    expect(JSON.parse(call.argumentsJson)).toEqual({
      actions: [
        { type: "navigate", target: "article" },
        { type: "scroll", target: "article.content", direction: "bottom" },
      ],
    });
    transport.disconnect();
  });

  it("emits ordinary Q&A without a tool call", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("question");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.some((event) => event.type === "user-text" && event.text.includes("visualize"))).toBe(true);
    expect(events.some((event) => event.type === "agent-text-done")).toBe(true);
    transport.disconnect();
  });

  it("stays silent for a cancelled result", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("focus");
    await vi.advanceTimersByTimeAsync(200);
    const call = toolCallFrom(events);
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({ ok: false, code: "cancelled", message: "The UI command was cancelled." }),
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((event) => event.type === "agent-audio-started")).toBe(false);
    transport.disconnect();
  });

  it("speaks the result message for a success", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("navigate");
    await vi.advanceTimersByTimeAsync(200);
    const call = toolCallFrom(events);
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({ ok: true, message: "Opened the library." }),
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "Opened the library.")).toBe(true);
    transport.disconnect();
  });

  it("speaks the failure message for a failed result", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("select");
    await vi.advanceTimersByTimeAsync(200);
    const call = toolCallFrom(events);
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({ ok: false, code: "execution_failed", message: "The UI command failed." }),
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "The UI command failed.")).toBe(true);
    transport.disconnect();
  });

  it("gives separate instances distinct call ids for the same script", async () => {
    vi.useFakeTimers();
    const callIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const transport = new VoiceDemoTransport();
      const events: NormalizedRealtimeEvent[] = [];
      transport.subscribe((event) => events.push(event));
      await transport.connect();
      transport.playScript("navigate");
      await vi.advanceTimersByTimeAsync(200);
      callIds.push(toolCallFrom(events).callId);
      transport.disconnect();
    }
    expect(callIds[0]).not.toBe(callIds[1]);
  });

  it("ignores late script callbacks after disconnect", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("select");
    transport.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("disconnected");
  });
});
