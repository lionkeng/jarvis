import type { NormalizedRealtimeEvent, RealtimeToolCall } from "./types.js";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function normalizeOpenAIEvent(value: unknown): NormalizedRealtimeEvent[] {
  const event = record(value);
  if (!event) return [];
  switch (event.type) {
    case "session.input_transcript.delta":
    case "session.output_transcript.delta": {
      const { delta, start_ms, end_ms } = event;
      if (typeof delta !== "string" || typeof start_ms !== "number" || typeof end_ms !== "number"
        || !Number.isFinite(start_ms) || !Number.isFinite(end_ms) || start_ms < 0 || end_ms < start_ms) return [];
      return [{ type: "live-caption", role: event.type === "session.input_transcript.delta" ? "user" : "agent", delta, startMs: start_ms, endMs: end_ms }];
    }
    case "session.usage.updated":
    case "session.closed": {
      const usage = record(event.usage);
      if (typeof usage?.seconds !== "number" || !Number.isFinite(usage.seconds) || usage.seconds < 0) return [];
      return [{ type: "session-usage", seconds: usage.seconds, final: event.type === "session.closed", reason: typeof event.reason === "string" ? event.reason : undefined }];
    }
    case "error": {
      const error = record(event.error);
      return [{
        type: "provider-error",
        message: typeof error?.message === "string" ? error.message : "Live provider error",
        code: typeof error?.code === "string" ? error.code : undefined,
        clientEventId: typeof error?.client_event_id === "string" ? error.client_event_id : undefined,
      }];
    }
    default:
      return [];
  }
}

const BACKEND_FAILURES: Record<string, "failed" | "incomplete" | "cancelled" | undefined> = {
  "response.failed": "failed",
  "response.incomplete": "incomplete",
  "response.cancelled": "cancelled",
};

interface ResponseBatch {
  responseId: string;
  calls: Map<string, RealtimeToolCall>;
  submitted: Set<string>;
  completed: boolean;
  continued: boolean;
}

export class LiveToolBatches {
  #batches = new Map<string, ResponseBatch>();
  #seenCalls = new Set<string>();

  receive(value: unknown): NormalizedRealtimeEvent[] {
    const envelope = record(value);
    if (envelope?.type !== "response.event" || typeof envelope.delegation_id !== "string") return [];
    const event = record(envelope.event);
    if (!event) return [];
    const response = record(event.response);
    const id = envelope.delegation_id;
    if (event.type === "response.created" && typeof response?.id === "string") {
      const current = this.#batches.get(id);
      if (current?.responseId !== response.id) this.#batches.set(id, { responseId: response.id, calls: new Map(), submitted: new Set(), completed: false, continued: false });
      return [];
    }
    const batch = this.#batches.get(id);
    if (!batch) return [];
    if (event.type === "response.output_item.done" && !batch.completed) {
      const item = record(event.item);
      if (item?.type === "function_call" && typeof item.call_id === "string" && item.call_id
        && typeof item.name === "string" && item.name && typeof item.arguments === "string" && !this.#seenCalls.has(item.call_id)) {
        this.#seenCalls.add(item.call_id);
        batch.calls.set(item.call_id, { callId: item.call_id, name: item.name, argumentsJson: item.arguments });
      }
    }
    if (event.type === "response.completed" && response?.id === batch.responseId && !batch.completed) {
      batch.completed = true;
      const events: NormalizedRealtimeEvent[] = [...batch.calls.values()].map((call) => ({ type: "tool-call", call }));
      const usage = record(response.usage);
      if (typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number" && typeof usage.total_tokens === "number") {
        events.unshift({ type: "backend-usage", delegationId: id, responseId: batch.responseId, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens });
      }
      return events;
    }
    const status = BACKEND_FAILURES[String(event.type)];
    if (status && response?.id === batch.responseId) {
      this.#batches.delete(id);
      return [{ type: "backend-failed", delegationId: id, responseId: batch.responseId, status }];
    }
    return [];
  }

  pending(callId: string): boolean {
    return [...this.#batches.values()].some((batch) => batch.completed && batch.calls.has(callId) && !batch.submitted.has(callId));
  }

  submitted(callId: string): boolean {
    for (const batch of this.#batches.values()) {
      if (!batch.calls.has(callId)) continue;
      batch.submitted.add(callId);
      if (!batch.continued && batch.completed && batch.calls.size === batch.submitted.size) {
        batch.continued = true;
        return true;
      }
    }
    return false;
  }
}
