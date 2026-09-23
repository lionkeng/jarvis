// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedRealtimeEvent } from "@jarvis-viz/core";
import { parseRequestUiChangesCall } from "@jarvis-viz/surface";
import { SIMULATION_TABLE } from "./runner-source.js";
import { VOICE_DEMO_SCRIPTS, VoiceDemoTransport, type VoiceDemoScriptId } from "./voice-demo-transport.js";

afterEach(() => {
  vi.useRealTimers();
});

function toolCallFrom(events: NormalizedRealtimeEvent[]) {
  const toolCall = events.find((event) => event.type === "tool-call");
  expect(toolCall?.type).toBe("tool-call");
  if (toolCall?.type !== "tool-call") throw new Error("expected tool-call");
  return toolCall.call;
}

async function play(id: VoiceDemoScriptId) {
  vi.useFakeTimers();
  const transport = new VoiceDemoTransport();
  const events: NormalizedRealtimeEvent[] = [];
  transport.subscribe((event) => events.push(event));
  await transport.connect();
  transport.playScript(id);
  await vi.advanceTimersByTimeAsync(200);
  return { transport, events };
}

function requestsOf(argumentsJson: string): string[] {
  const parsed: unknown = JSON.parse(argumentsJson);
  if (typeof parsed !== "object" || parsed === null || !("requests" in parsed)) throw new Error("expected requests");
  const { requests } = parsed as { requests: unknown };
  if (!Array.isArray(requests)) throw new Error("expected a requests array");
  return requests.map(String);
}

describe("VoiceDemoTransport", () => {
  it("emits the compound navigate-then-scroll sentences", async () => {
    const { transport, events } = await play("navigate-scroll");
    const call = toolCallFrom(events);
    expect(events.some((event) => event.type === "user-text" && event.text === "Open article and scroll")).toBe(true);
    expect(call.name).toBe("request_ui_changes");
    expect(JSON.parse(call.argumentsJson)).toEqual({
      requests: ["go to the article page", "scroll the article down"],
    });
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({
        ok: true,
        message: "Opened the article page. Scrolled down.",
        results: [
          { request: "go to the article page", status: "done", say: "Opened the article page." },
          { request: "scroll the article down", status: "done", say: "Scrolled down." },
        ],
      }),
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "Opened the article page. Scrolled down.")).toBe(true);
    expect(events.some((event) => event.type === "response-done")).toBe(true);
    expect(transport.submittedToolResults).toHaveLength(1);
    transport.disconnect();
  });

  it("asks for the bottom of the article in the explicit script", async () => {
    const { transport, events } = await play("navigate-scroll-bottom");
    expect(JSON.parse(toolCallFrom(events).argumentsJson)).toEqual({
      requests: ["go to the article page", "scroll the article to the bottom"],
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
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.some((event) => event.type === "user-text" && event.text.includes("visualize"))).toBe(true);
    expect(events.some((event) => event.type === "agent-text-done")).toBe(true);
    transport.disconnect();
  });

  it("stays silent when any result was cancelled", async () => {
    const { transport, events } = await play("focus");
    const call = toolCallFrom(events);
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({
        ok: false,
        message: "Cancelled.",
        results: [
          { request: "go to the dashboard page", status: "done", say: "Opened the dashboard page." },
          { request: "put the cursor in the search box", status: "cancelled" },
        ],
      }),
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(events.some((event) => event.type === "agent-audio-started")).toBe(false);
    transport.disconnect();
  });

  it("speaks the report message for a success", async () => {
    const { transport, events } = await play("navigate");
    const call = toolCallFrom(events);
    expect(JSON.parse(call.argumentsJson)).toEqual({ requests: ["go to the library page"] });
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({ ok: true, message: "Opened the library page.", results: [{ request: "go to the library page", status: "done", say: "Opened the library page." }] }),
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "Opened the library page.")).toBe(true);
    transport.disconnect();
  });

  it("speaks the report message for a failure", async () => {
    const { transport, events } = await play("select");
    const call = toolCallFrom(events);
    transport.submitToolResult({
      callId: call.callId,
      output: JSON.stringify({
        ok: false,
        message: "I could not work out what to change.",
        results: [{ request: "go to the library page", status: "interpret_failed" }],
      }),
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(events.some((event) => event.type === "agent-text-done" && event.text === "I could not work out what to change.")).toBe(true);
    transport.disconnect();
  });

  it("gives separate instances distinct call ids for the same script", async () => {
    const callIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const { transport, events } = await play("navigate");
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

  it("emits only sentences the simulated table answers", async () => {
    for (const script of VOICE_DEMO_SCRIPTS) {
      const { transport, events } = await play(script.id);
      const toolCall = events.find((event) => event.type === "tool-call");
      if (toolCall?.type !== "tool-call") {
        expect(script.id).toBe("question");
        transport.disconnect();
        continue;
      }
      const parsed = parseRequestUiChangesCall(toolCall.call);
      expect(parsed.ok).toBe(true);
      for (const sentence of requestsOf(toolCall.call.argumentsJson)) {
        expect(SIMULATION_TABLE[sentence]).toBeDefined();
      }
      transport.disconnect();
    }
  });
});
