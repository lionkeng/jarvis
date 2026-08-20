import { describe, expect, it } from "vitest";
import type { RealtimeToolCall } from "@jarvis-viz/core";
import {
  PERFORM_UI_ACTIONS_TOOL,
  parseToolCall,
  serializeBatchResult,
  successResult,
  toWireAction,
  type UiCommand,
} from "./interaction-contract.js";

function call(actions: unknown, name = PERFORM_UI_ACTIONS_TOOL): RealtimeToolCall {
  return { callId: "call_1", name, argumentsJson: JSON.stringify({ actions }) };
}

function rawCall(argumentsJson: string, name = PERFORM_UI_ACTIONS_TOOL): RealtimeToolCall {
  return { callId: "call_1", name, argumentsJson };
}

const ALLOWED: Array<{ raw: Record<string, unknown>; command: UiCommand }> = [
  { raw: { type: "navigate", target: "dashboard" }, command: { type: "navigate", route: "dashboard" } },
  { raw: { type: "navigate", target: "library" }, command: { type: "navigate", route: "library" } },
  { raw: { type: "navigate", target: "article" }, command: { type: "navigate", route: "article" } },
  { raw: { type: "navigate", target: "settings" }, command: { type: "navigate", route: "settings" } },
  { raw: { type: "open", target: "library.details" }, command: { type: "open", target: "library.details" } },
  { raw: { type: "close", target: "library.details" }, command: { type: "close", target: "library.details" } },
  { raw: { type: "select", target: "library.item", value: "atlas" }, command: { type: "select", target: "library.item", value: "atlas" } },
  { raw: { type: "select", target: "library.item", value: "beacon" }, command: { type: "select", target: "library.item", value: "beacon" } },
  { raw: { type: "select", target: "library.item", value: "cinder" }, command: { type: "select", target: "library.item", value: "cinder" } },
  { raw: { type: "select", target: "settings.theme", value: "light" }, command: { type: "select", target: "settings.theme", value: "light" } },
  { raw: { type: "select", target: "settings.theme", value: "dark" }, command: { type: "select", target: "settings.theme", value: "dark" } },
  { raw: { type: "select", target: "settings.theme", value: "system" }, command: { type: "select", target: "settings.theme", value: "system" } },
  { raw: { type: "scroll", target: "article.content", direction: "up" }, command: { type: "scroll", target: "article.content", direction: "up" } },
  { raw: { type: "scroll", target: "article.content", direction: "down" }, command: { type: "scroll", target: "article.content", direction: "down" } },
  { raw: { type: "scroll", target: "article.content", direction: "top" }, command: { type: "scroll", target: "article.content", direction: "top" } },
  { raw: { type: "scroll", target: "article.content", direction: "bottom" }, command: { type: "scroll", target: "article.content", direction: "bottom" } },
  { raw: { type: "scroll", target: "library.results", direction: "up" }, command: { type: "scroll", target: "library.results", direction: "up" } },
  { raw: { type: "scroll", target: "library.results", direction: "down" }, command: { type: "scroll", target: "library.results", direction: "down" } },
  { raw: { type: "scroll", target: "library.results", direction: "top" }, command: { type: "scroll", target: "library.results", direction: "top" } },
  { raw: { type: "scroll", target: "library.results", direction: "bottom" }, command: { type: "scroll", target: "library.results", direction: "bottom" } },
  { raw: { type: "focus", target: "dashboard.search" }, command: { type: "focus", target: "dashboard.search" } },
  { raw: { type: "activate", target: "article.bookmark" }, command: { type: "activate", target: "article.bookmark" } },
];

describe("parseToolCall", () => {
  it.each(ALLOWED)("parses $raw.type $raw.target $raw.value $raw.direction", ({ raw, command }) => {
    expect(parseToolCall(call([raw]))).toEqual({ ok: true, commands: [command] });
  });

  it("preserves compound batch order", () => {
    const result = parseToolCall(call([
      { type: "navigate", target: "article" },
      { type: "scroll", target: "article.content", direction: "bottom" },
      { type: "activate", target: "article.bookmark" },
    ]));
    expect(result).toEqual({
      ok: true,
      commands: [
        { type: "navigate", route: "article" },
        { type: "scroll", target: "article.content", direction: "bottom" },
        { type: "activate", target: "article.bookmark" },
      ],
    });
  });

  it("parses a five-action batch", () => {
    const result = parseToolCall(call([
      { type: "navigate", target: "library" },
      { type: "open", target: "library.details" },
      { type: "select", target: "library.item", value: "atlas" },
      { type: "close", target: "library.details" },
      { type: "navigate", target: "settings" },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commands).toHaveLength(5);
  });

  it("rejects malformed JSON", () => {
    expect(parseToolCall(rawCall("{"))).toEqual({
      ok: false,
      result: expect.objectContaining({ ok: false, code: "invalid_arguments", applied: [] }),
    });
  });

  it("rejects a non-object root", () => {
    expect(parseToolCall(rawCall("[]")).ok).toBe(false);
    expect(parseToolCall(rawCall("null")).ok).toBe(false);
    expect(parseToolCall(rawCall("\"navigate\"")).ok).toBe(false);
  });

  it("rejects extra root fields", () => {
    const result = parseToolCall(rawCall(JSON.stringify({
      actions: [{ type: "focus", target: "dashboard.search" }],
      selector: "#main",
    })));
    expect(result).toMatchObject({ ok: false, result: { code: "invalid_arguments" } });
  });

  it("rejects extra action fields", () => {
    const result = parseToolCall(call([{ type: "focus", target: "dashboard.search", selector: ".search" }]));
    expect(result).toMatchObject({ ok: false, result: { code: "invalid_arguments", actionIndex: 0 } });
  });

  it("rejects invented targets", () => {
    expect(parseToolCall(call([{ type: "navigate", target: "admin" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
    expect(parseToolCall(call([{ type: "open", target: "library.secret" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
  });

  it("rejects unsupported action and target combinations", () => {
    expect(parseToolCall(call([{ type: "navigate", target: "library.details" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
    expect(parseToolCall(call([{ type: "scroll", target: "dashboard.search", direction: "down" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
    expect(parseToolCall(call([{ type: "select", target: "library.item", value: "dark" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
    expect(parseToolCall(call([{ type: "open", target: "article.bookmark" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
  });

  it("rejects invalid values and directions", () => {
    expect(parseToolCall(call([{ type: "select", target: "settings.theme", value: "blue" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
    expect(parseToolCall(call([{ type: "scroll", target: "article.content", direction: "left" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
  });

  it("rejects unused fields on an otherwise valid action", () => {
    expect(parseToolCall(call([{ type: "navigate", target: "article", direction: "down" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
    expect(parseToolCall(call([{ type: "focus", target: "dashboard.search", value: "atlas" }]))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", actionIndex: 0 },
    });
  });

  it("rejects empty and oversized action arrays", () => {
    expect(parseToolCall(call([]))).toMatchObject({ ok: false, result: { code: "invalid_arguments" } });
    const oversized = parseToolCall(call(Array.from({ length: 6 }, () => ({ type: "navigate", target: "dashboard" }))));
    expect(oversized).toMatchObject({ ok: false, result: { code: "invalid_arguments" } });
    if (!oversized.ok) expect(oversized.result.actionIndex).toBeUndefined();
  });

  it("rejects the wrong tool name", () => {
    expect(parseToolCall(call([{ type: "focus", target: "dashboard.search" }], "click_element"))).toMatchObject({
      ok: false,
      result: { code: "invalid_arguments", applied: [] },
    });
  });

  it("round-trips accepted commands through the wire shape", () => {
    for (const { raw, command } of ALLOWED) {
      expect(toWireAction(command)).toEqual(raw);
      expect(parseToolCall(call([toWireAction(command)]))).toEqual({ ok: true, commands: [command] });
    }
  });

  it("serializes reported results with wire targets and a result-first success line", () => {
    expect(successResult([{ type: "navigate", route: "library" }]).message).toBe("Opened the library.");
    expect(successResult([
      { type: "navigate", route: "article" },
      { type: "scroll", target: "article.content", direction: "down" },
    ]).message).toBe("Opened the article and scrolled down.");
    const serialized = JSON.parse(serializeBatchResult(successResult([{ type: "navigate", route: "library" }]))) as {
      applied: unknown;
      message: string;
    };
    expect(serialized.applied).toEqual([{ type: "navigate", target: "library" }]);
    expect(serialized.message).not.toMatch(/action/i);
  });

  it("points at the first invalid action in a mixed batch", () => {
    const result = parseToolCall(call([
      { type: "navigate", target: "library" },
      { type: "select", target: "library.item", value: "atlas" },
      { type: "click", target: "library.item" },
    ]));
    expect(result).toMatchObject({ ok: false, result: { code: "invalid_arguments", actionIndex: 2, applied: [] } });
  });
});
