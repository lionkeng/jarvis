import { describe, expect, it } from "vitest";
import {
  MAX_REQUESTS_PER_CALL,
  REQUEST_UI_CHANGES_TOOL,
  parseRequestUiChangesCall,
  renderToolReport,
  type RequestReport,
} from "./tool.js";
import type { ToolCall } from "./types.js";

function call(argumentsJson: string, name = REQUEST_UI_CHANGES_TOOL): ToolCall {
  return { callId: "call-1", name, argumentsJson };
}

describe("parseRequestUiChangesCall", () => {
  it("accepts one to five non-empty request sentences", () => {
    expect(parseRequestUiChangesCall(call('{"requests":["go to the library page"]}'))).toEqual({
      ok: true,
      requests: ["go to the library page"],
    });
    const five = Array.from({ length: MAX_REQUESTS_PER_CALL }, (_, index) => `request ${index}`);
    expect(parseRequestUiChangesCall(call(JSON.stringify({ requests: five })))).toEqual({ ok: true, requests: five });
  });

  it("rejects another tool name", () => {
    expect(parseRequestUiChangesCall(call('{"requests":["go home"]}', "perform_ui_actions")).ok).toBe(false);
  });

  it("rejects arguments that are not JSON", () => {
    expect(parseRequestUiChangesCall(call("{requests:")).ok).toBe(false);
  });

  it("rejects arguments that are not a plain object", () => {
    expect(parseRequestUiChangesCall(call('["go home"]')).ok).toBe(false);
    expect(parseRequestUiChangesCall(call("null")).ok).toBe(false);
    expect(parseRequestUiChangesCall(call('"go home"')).ok).toBe(false);
  });

  it("rejects any key beside requests", () => {
    expect(parseRequestUiChangesCall(call('{"requests":["go home"],"why":"because"}')).ok).toBe(false);
    expect(parseRequestUiChangesCall(call('{"actions":["go home"]}')).ok).toBe(false);
  });

  it("rejects an empty list and more than five requests", () => {
    expect(parseRequestUiChangesCall(call('{"requests":[]}')).ok).toBe(false);
    const six = Array.from({ length: 6 }, (_, index) => `request ${index}`);
    expect(parseRequestUiChangesCall(call(JSON.stringify({ requests: six }))).ok).toBe(false);
  });

  it("rejects a request that is not a non-empty string", () => {
    expect(parseRequestUiChangesCall(call('{"requests":[""]}')).ok).toBe(false);
    expect(parseRequestUiChangesCall(call('{"requests":["   "]}')).ok).toBe(false);
    expect(parseRequestUiChangesCall(call('{"requests":[3]}')).ok).toBe(false);
    expect(parseRequestUiChangesCall(call('{"requests":["go home",null]}')).ok).toBe(false);
  });
});

describe("renderToolReport", () => {
  it("joins the spoken facts of a call where every request is done", () => {
    const results: RequestReport[] = [
      { request: "go to the library page", status: "done", say: "Opened the library." },
      { request: "select Atlas", status: "done", say: "Selected Atlas." },
    ];
    expect(renderToolReport(results)).toEqual({
      ok: true,
      message: "Opened the library. Selected Atlas.",
      results,
    });
  });

  it("says Done when no request reported a spoken fact", () => {
    expect(renderToolReport([{ request: "scroll down", status: "done" }]).message).toBe("Done.");
  });

  it("stays ok when a request had no effect", () => {
    const report = renderToolReport([{ request: "close the panel", status: "no_effect", say: "It was already closed." }]);
    expect(report.ok).toBe(true);
    expect(report.message).toBe("It was already closed.");
  });

  it("asks which one for an unclear request", () => {
    const report = renderToolReport([{ request: "select one", status: "unclear", candidates: ["Atlas", "Beacon"] }]);
    expect(report).toMatchObject({ ok: false, message: "Which one: Atlas or Beacon?" });
  });

  it("says the request is not on this screen for none", () => {
    expect(renderToolReport([{ request: "what time is it", status: "none" }])).toMatchObject({
      ok: false,
      message: "That is not something on this screen.",
    });
  });

  it("speaks the outcome's own words for an unavailable request", () => {
    const report = renderToolReport([
      { request: "add the deck", status: "unavailable", say: "The covered porch has to be on first." },
    ]);
    expect(report).toMatchObject({ ok: false, message: "The covered porch has to be on first." });
  });

  it("gives one fixed sentence for each failure code", () => {
    const codes = ["cancelled", "failed", "interpret_failed", "queue_full", "invalid_arguments"] as const;
    expect(codes.map((status) => renderToolReport([{ request: "go home", status }]).message)).toEqual([
      "Cancelled.",
      "That did not work.",
      "I could not work out what to change.",
      "Too many requests at once.",
      "That request was not understood.",
    ]);
  });

  it("reports the first request that did not finish", () => {
    const results: RequestReport[] = [
      { request: "go to the library page", status: "done", say: "Opened the library." },
      { request: "select one", status: "unclear", candidates: ["Atlas", "Beacon"] },
    ];
    expect(renderToolReport(results)).toEqual({
      ok: false,
      message: "Which one: Atlas or Beacon?",
      results,
    });
  });
});
