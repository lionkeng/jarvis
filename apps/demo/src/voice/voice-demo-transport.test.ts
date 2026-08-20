// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedRealtimeEvent } from "@jarvis-viz/core";
import { VoiceDemoTransport } from "./voice-demo-transport.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceDemoTransport", () => {
  it("plays a UI script through speech, a tool call, and a matching result acknowledgement", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("navigate-scroll");
    await vi.advanceTimersByTimeAsync(200);
    const toolCall = events.find((event) => event.type === "tool-call");
    expect(toolCall?.type).toBe("tool-call");
    if (toolCall?.type !== "tool-call") throw new Error("expected tool-call");
    expect(toolCall.call.name).toBe("perform_ui_actions");
    expect(JSON.parse(toolCall.call.argumentsJson)).toEqual({
      actions: [
        { type: "navigate", target: "article" },
        { type: "scroll", target: "article.content", direction: "bottom" },
      ],
    });
    transport.submitToolResult({ callId: toolCall.call.callId, output: JSON.stringify({ ok: true, message: "Scrolled." }) });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "Scrolled.")).toBe(true);
    expect(events.some((event) => event.type === "response-done")).toBe(true);
    expect(transport.submittedToolResults).toHaveLength(1);
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

  it("does not start a spoken follow-up for a cancelled result", async () => {
    vi.useFakeTimers();
    const transport = new VoiceDemoTransport();
    const events: NormalizedRealtimeEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();
    transport.playScript("focus");
    await vi.advanceTimersByTimeAsync(200);
    const toolCall = events.find((event) => event.type === "tool-call");
    if (toolCall?.type !== "tool-call") throw new Error("expected tool-call");
    transport.submitToolResult({
      callId: toolCall.call.callId,
      output: JSON.stringify({ ok: false, code: "cancelled", message: "Cancelled." }),
      continueResponse: false,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((event) => event.type === "agent-audio-started")).toBe(false);
    transport.disconnect();
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
