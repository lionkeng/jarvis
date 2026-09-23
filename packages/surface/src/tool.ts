import type { ToolCall } from "./types.js";

export const REQUEST_UI_CHANGES_TOOL = "request_ui_changes";
export const MIN_REQUESTS_PER_CALL = 1;
export const MAX_REQUESTS_PER_CALL = 5;

export type ParsedRequestUiChanges = { ok: true; requests: string[] } | { ok: false; reason: string };

export type RequestReport =
  | { request: string; status: "done" | "no_effect" | "unavailable"; say?: string; effects?: string[] }
  | { request: string; status: "unclear"; candidates: string[] }
  | { request: string; status: "none" }
  | { request: string; status: "cancelled" | "failed" | "interpret_failed" | "queue_full" | "invalid_arguments" };

export interface ToolReport {
  ok: boolean;
  message: string;
  results: RequestReport[];
}

export const FAILURE_MESSAGES = {
  cancelled: "Cancelled.",
  failed: "That did not work.",
  interpret_failed: "I could not work out what to change.",
  queue_full: "Too many requests at once.",
  invalid_arguments: "That request was not understood.",
} as const;

export const NO_CONTROL_MESSAGE = "That is not something on this screen.";
export const UNAVAILABLE_MESSAGE = "That is not available right now.";
export const NO_EFFECT_MESSAGE = "Nothing changed.";
export const DONE_MESSAGE = "Done.";

export function parseRequestUiChangesCall(call: ToolCall): ParsedRequestUiChanges {
  if (call.name !== REQUEST_UI_CHANGES_TOOL) return { ok: false, reason: `unknown tool ${call.name}` };
  let payload: unknown;
  try {
    payload = JSON.parse(call.argumentsJson);
  } catch {
    return { ok: false, reason: "arguments are not JSON" };
  }
  if (!isPlainObject(payload)) return { ok: false, reason: "arguments are not an object" };
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "requests") return { ok: false, reason: "arguments hold keys other than requests" };
  const { requests } = payload;
  if (!Array.isArray(requests)) return { ok: false, reason: "requests is not an array" };
  if (requests.length < MIN_REQUESTS_PER_CALL || requests.length > MAX_REQUESTS_PER_CALL) {
    return { ok: false, reason: `requests holds ${requests.length} items` };
  }
  const parsed: string[] = [];
  for (const request of requests) {
    if (typeof request !== "string" || request.trim().length === 0) {
      return { ok: false, reason: "a request is not a non-empty string" };
    }
    parsed.push(request);
  }
  return { ok: true, requests: parsed };
}

export function renderToolReport(results: RequestReport[]): ToolReport {
  const deciding = results.find((result) => result.status !== "done" && result.status !== "no_effect");
  if (deciding === undefined) {
    const spoken = results.flatMap((result) => ("say" in result && result.say ? [result.say] : []));
    return { ok: true, message: spoken.length > 0 ? spoken.join(" ") : DONE_MESSAGE, results };
  }
  return { ok: false, message: messageFor(deciding), results };
}

function messageFor(result: RequestReport): string {
  switch (result.status) {
    case "unclear":
      return result.candidates.length > 0 ? `Which one: ${result.candidates.join(" or ")}?` : "Which one do you mean?";
    case "none":
      return NO_CONTROL_MESSAGE;
    case "unavailable":
      return result.say ?? UNAVAILABLE_MESSAGE;
    case "no_effect":
      return result.say ?? NO_EFFECT_MESSAGE;
    case "done":
      return result.say ?? DONE_MESSAGE;
    default:
      return FAILURE_MESSAGES[result.status];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
