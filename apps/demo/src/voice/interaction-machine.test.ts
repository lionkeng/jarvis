import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "xstate";
import type { RealtimeToolResult } from "@jarvis-viz/core";
import { UiCapabilityRegistry } from "./capability-registry.js";
import { INTERACTION_QUEUE_LIMIT } from "./interaction-contract.js";
import { createInteractionActor } from "./interaction-machine.js";
import type { UiCommand } from "./interaction-contract.js";

afterEach(() => {
  vi.useRealTimers();
});

function toolCall(callId: string, commands: unknown[]) {
  return {
    callId,
    name: "perform_ui_actions",
    argumentsJson: JSON.stringify({ actions: commands }),
  };
}

function createHarness() {
  const registry = new UiCapabilityRegistry();
  const submitted: RealtimeToolResult[] = [];
  const executed: UiCommand[] = [];
  registry.register("navigation", {
    supportedActions: ["navigate"],
    execute: async (command) => { executed.push(command); },
  });
  registry.register("article.content", {
    supportedActions: ["scroll"],
    execute: async (command) => { executed.push(command); },
  });
  registry.register("dashboard.search", {
    supportedActions: ["focus"],
    execute: async (command) => { executed.push(command); },
  });
  const actor = createInteractionActor({
    registry,
    resultPort: { submit: (result) => submitted.push(result) },
  });
  actor.start();
  return { actor, registry, submitted, executed };
}

describe("interaction machine", () => {
  it("validates, executes, and reports a successful voice request exactly once", async () => {
    const { actor, submitted, executed } = createHarness();
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_ok", [{ type: "navigate", target: "library" }]) });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 1);
    expect(executed).toEqual([{ type: "navigate", route: "library" }]);
    expect(submitted[0]?.followUp).toBe("brief-acknowledgement");
    expect(JSON.parse(submitted[0]!.output)).toMatchObject({
      ok: true,
      message: "Opened the library.",
      applied: [{ type: "navigate", target: "library" }],
    });
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_ok", [{ type: "navigate", target: "library" }]) });
    await Promise.resolve();
    expect(submitted).toHaveLength(1);
    actor.stop();
  });

  it("reports invalid arguments without executing", async () => {
    const { actor, submitted, executed } = createHarness();
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_bad", [{ type: "click", selector: "#x" }]) });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 1);
    expect(executed).toEqual([]);
    expect(submitted[0]?.followUp).toBe("default");
    expect(JSON.parse(submitted[0]!.output)).toMatchObject({ ok: false, code: "invalid_arguments" });
    actor.stop();
  });

  it("keeps earlier effects when a later action fails", async () => {
    const { actor, registry, submitted, executed } = createHarness();
    registry.register("library.item", {
      supportedActions: ["select"],
      execute: async () => { throw new Error("boom"); },
    });
    actor.send({
      type: "TOOL_CALL_RECEIVED",
      call: toolCall("call_partial", [
        { type: "navigate", target: "library" },
        { type: "select", target: "library.item", value: "atlas" },
      ]),
    });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 1);
    expect(executed).toEqual([{ type: "navigate", route: "library" }]);
    expect(submitted[0]?.followUp).toBe("default");
    expect(JSON.parse(submitted[0]!.output)).toMatchObject({
      ok: false,
      code: "execution_failed",
      actionIndex: 1,
      applied: [{ type: "navigate", target: "library" }],
    });
    actor.stop();
  });

  it("runs queued voice requests in FIFO order", async () => {
    const { actor, submitted, executed } = createHarness();
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_a", [{ type: "navigate", target: "library" }]) });
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_b", [{ type: "navigate", target: "article" }]) });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 2);
    expect(executed).toEqual([
      { type: "navigate", route: "library" },
      { type: "navigate", route: "article" },
    ]);
    expect(submitted.map((result) => result.callId)).toEqual(["call_a", "call_b"]);
    actor.stop();
  });

  it("rejects overflow voice requests with queue_full and leaves pointer requests unqueued", async () => {
    const registry = new UiCapabilityRegistry();
    const submitted: RealtimeToolResult[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register("navigation", {
      supportedActions: ["navigate"],
      execute: async () => blocked,
    });
    const actor = createInteractionActor({
      registry,
      resultPort: { submit: (result) => submitted.push(result) },
    });
    actor.start();
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("active", [{ type: "navigate", target: "library" }]) });
    await waitFor(actor, (state) => state.matches("executing"));
    for (let index = 0; index < INTERACTION_QUEUE_LIMIT; index += 1) {
      actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall(`queued_${index}`, [{ type: "navigate", target: "dashboard" }]) });
    }
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("overflow", [{ type: "navigate", target: "settings" }]) });
    actor.send({ type: "TYPED_REQUEST", source: "pointer", commands: [{ type: "focus", target: "dashboard.search" }] });
    const overflow = submitted.find((result) => result.callId === "overflow");
    expect(overflow).toBeDefined();
    expect(overflow?.followUp).toBe("default");
    expect(JSON.parse(overflow!.output)).toMatchObject({ code: "queue_full" });
    expect(actor.getSnapshot().context.queue).toHaveLength(INTERACTION_QUEUE_LIMIT);
    release();
    await waitFor(actor, (state) => state.matches("ready") && state.context.queue.length === 0, { timeout: 2_000 });
    actor.stop();
  });

  it("cancels execution without a spoken follow-up", async () => {
    const registry = new UiCapabilityRegistry();
    const submitted: RealtimeToolResult[] = [];
    registry.register("navigation", {
      supportedActions: ["navigate"],
      execute: async (_command, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    });
    const actor = createInteractionActor({
      registry,
      resultPort: { submit: (result) => submitted.push(result) },
    });
    actor.start();
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_cancel", [{ type: "navigate", target: "library" }]) });
    await waitFor(actor, (state) => state.matches("executing"));
    actor.send({ type: "VOICE_INTERRUPTED" });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 1);
    expect(submitted[0]?.followUp).toBe("none");
    expect(JSON.parse(submitted[0]!.output)).toMatchObject({ code: "cancelled" });
    actor.stop();
  });

  it("reports target_unavailable with default follow-up when a capability never appears", async () => {
    const registry = new UiCapabilityRegistry();
    const submitted: RealtimeToolResult[] = [];
    const actor = createInteractionActor({
      registry,
      resultPort: { submit: (result) => submitted.push(result) },
    });
    actor.start();
    actor.send({
      type: "TOOL_CALL_RECEIVED",
      call: toolCall("call_missing", [{ type: "scroll", target: "article.content", direction: "down" }]),
    });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 1, { timeout: 3_000 });
    expect(submitted[0]?.followUp).toBe("default");
    expect(JSON.parse(submitted[0]!.output)).toMatchObject({ ok: false, code: "target_unavailable" });
    actor.stop();
  });

  it("waits for a late page capability after navigation", async () => {
    const registry = new UiCapabilityRegistry();
    const submitted: unknown[] = [];
    const executed: UiCommand[] = [];
    registry.register("navigation", {
      supportedActions: ["navigate"],
      execute: async (command) => { executed.push(command); },
    });
    const actor = createInteractionActor({
      registry,
      resultPort: { submit: (result) => submitted.push(result) },
    });
    actor.start();
    actor.send({
      type: "TOOL_CALL_RECEIVED",
      call: toolCall("call_ready", [
        { type: "navigate", target: "article" },
        { type: "scroll", target: "article.content", direction: "bottom" },
      ]),
    });
    await waitFor(actor, (state) => state.matches("executing"));
    registry.register("article.content", {
      supportedActions: ["scroll"],
      execute: async (command) => { executed.push(command); },
    });
    await waitFor(actor, (state) => state.matches("ready") && submitted.length === 1);
    expect(executed).toEqual([
      { type: "navigate", route: "article" },
      { type: "scroll", target: "article.content", direction: "bottom" },
    ]);
    actor.stop();
  });

  it("does not report pointer requests to the provider", async () => {
    const { actor, submitted, executed } = createHarness();
    actor.send({ type: "TYPED_REQUEST", source: "pointer", commands: [{ type: "focus", target: "dashboard.search" }] });
    await waitFor(actor, (state) => state.matches("ready") && executed.length === 1);
    expect(submitted).toHaveLength(0);
    expect(executed).toEqual([{ type: "focus", target: "dashboard.search" }]);
    actor.stop();
  });

  it("records a reporting failure when the result port throws", async () => {
    const registry = new UiCapabilityRegistry();
    registry.register("navigation", { supportedActions: ["navigate"], execute: async () => undefined });
    const actor = createInteractionActor({
      registry,
      resultPort: { submit: () => { throw new Error("Realtime data channel is not open"); } },
    });
    actor.start();
    actor.send({ type: "TOOL_CALL_RECEIVED", call: toolCall("call_report", [{ type: "navigate", target: "dashboard" }]) });
    await waitFor(actor, (state) => state.matches("ready") && state.context.reportingFailed);
    actor.stop();
  });
});
