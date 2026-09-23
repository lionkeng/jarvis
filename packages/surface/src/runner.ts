import { compileInterpretRequest } from "./compile.js";
import { DEFAULT_BARS, decodeInterpretAnswers } from "./decode.js";
import { CapabilityRegistryError, type VoiceRegistry } from "./registry.js";
import { parseRequestUiChangesCall, renderToolReport, type RequestReport } from "./tool.js";
import type {
  ConfidenceBars,
  InterpretAnswers,
  InterpretRequest,
  ToolCall,
  ToolResult,
  VoiceControl,
} from "./types.js";

export const COMPLETED_CALL_ID_LIMIT = 64;
export const DEFAULT_QUEUE_LIMIT = 8;

export type Interpret = (request: InterpretRequest, signal: AbortSignal) => Promise<InterpretAnswers>;

export interface RunnerSnapshot {
  phase: "idle" | "interpreting" | "executing" | "reporting";
  callId?: string;
  request?: string;
  reports: RequestReport[];
  lastMessage?: string;
  timing: { interpretMs?: number; executeMs?: number; addedMs?: number };
  queued: number;
}

export interface VoiceRunner {
  handle(call: ToolCall): void;
  interrupt(): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RunnerSnapshot;
}

export interface VoiceRunnerOptions {
  registry: VoiceRegistry;
  interpret: Interpret;
  submit: (result: ToolResult) => void;
  screen: () => Record<string, string>;
  bars?: ConfidenceBars;
  queueLimit?: number;
}

export function createVoiceRunner(options: VoiceRunnerOptions): VoiceRunner {
  const { registry, interpret, submit, screen } = options;
  const bars = options.bars ?? DEFAULT_BARS;
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;

  const listeners = new Set<() => void>();
  const completed: string[] = [];
  const known = new Set<string>();
  let generation = 0;
  let active: AbortController | undefined;
  let chain: Promise<void> = Promise.resolve();

  let phase: RunnerSnapshot["phase"] = "idle";
  let callId: string | undefined;
  let request: string | undefined;
  let reports: RequestReport[] = [];
  let lastMessage: string | undefined;
  let interpretMs: number | undefined;
  let executeMs: number | undefined;
  let addedMs: number | undefined;
  let queued = 0;
  let snapshot: RunnerSnapshot = { phase: "idle", reports: [], timing: {}, queued: 0 };

  function publish(): void {
    snapshot = {
      phase,
      reports,
      timing: {
        ...(interpretMs !== undefined ? { interpretMs } : {}),
        ...(executeMs !== undefined ? { executeMs } : {}),
        ...(addedMs !== undefined ? { addedMs } : {}),
      },
      queued,
      ...(callId !== undefined ? { callId } : {}),
      ...(request !== undefined ? { request } : {}),
      ...(lastMessage !== undefined ? { lastMessage } : {}),
    };
    for (const listener of [...listeners]) listener();
  }

  function remember(id: string): void {
    if (completed.includes(id)) return;
    completed.push(id);
    if (completed.length > COMPLETED_CALL_ID_LIMIT) completed.splice(0, completed.length - COMPLETED_CALL_ID_LIMIT);
  }

  function submitReport(id: string, results: RequestReport[]): string {
    const report = renderToolReport(results);
    if (completed.includes(id)) return report.message;
    remember(id);
    try {
      submit({ callId: id, output: JSON.stringify(report) });
    } catch (error) {
      console.error("Voice runner failed to submit a tool result", error);
    }
    return report.message;
  }

  function finish(id: string, results: RequestReport[]): void {
    phase = "reporting";
    reports = results;
    lastMessage = renderToolReport(results).message;
    publish();
    known.delete(id);
    submitReport(id, results);
    phase = "idle";
    callId = undefined;
    request = undefined;
    publish();
  }

  async function runRequest(sentence: string, signal: AbortSignal, receivedAt: number): Promise<RequestReport> {
    request = sentence;
    phase = "interpreting";
    publish();
    let controls: VoiceControl[] = [];
    let answers: InterpretAnswers;
    try {
      await registry.settle(signal);
      const described = registry.describe();
      controls = described.controls;
      const compiled = compileInterpretRequest({
        request: sentence,
        screen: { ...screen(), ...described.facts },
        controls,
      });
      const startedAt = Date.now();
      answers = await interpret(compiled, signal);
      interpretMs = Date.now() - startedAt;
    } catch (error) {
      return { request: sentence, status: isCancelled(error, signal) ? "cancelled" : "interpret_failed" };
    }

    const interpretation = decodeInterpretAnswers({ answers: answers.answers, controls, bars });
    switch (interpretation.kind) {
      case "none":
        return { request: sentence, status: "none" };
      case "unclear":
        return { request: sentence, status: "unclear", candidates: interpretation.candidates };
      case "malformed":
        return { request: sentence, status: "interpret_failed" };
      case "command":
        break;
      default: {
        const unreachable: never = interpretation;
        throw new Error(`Unexpected interpretation ${JSON.stringify(unreachable)}`);
      }
    }

    if (signal.aborted) return { request: sentence, status: "cancelled" };
    phase = "executing";
    if (addedMs === undefined) addedMs = Date.now() - receivedAt;
    publish();
    const startedAt = Date.now();
    try {
      const outcome = await registry.execute(interpretation.command, signal);
      executeMs = Date.now() - startedAt;
      return {
        request: sentence,
        status: outcome.status,
        ...(outcome.say !== undefined ? { say: outcome.say } : {}),
        ...(outcome.effects !== undefined ? { effects: outcome.effects } : {}),
      };
    } catch (error) {
      executeMs = Date.now() - startedAt;
      return { request: sentence, status: isCancelled(error, signal) ? "cancelled" : "failed" };
    }
  }

  async function run(call: ToolCall, receivedAt: number, startedGeneration: number): Promise<void> {
    queued = queued > 0 ? queued - 1 : 0;
    publish();
    if (startedGeneration !== generation) {
      known.delete(call.callId);
      remember(call.callId);
      return;
    }
    const controller = new AbortController();
    active = controller;
    callId = call.callId;
    request = undefined;
    interpretMs = undefined;
    executeMs = undefined;
    addedMs = undefined;
    const results: RequestReport[] = [];
    try {
      const parsed = parseRequestUiChangesCall(call);
      if (!parsed.ok) {
        results.push({ request: "", status: "invalid_arguments" });
        return;
      }
      for (const sentence of parsed.requests) {
        const report = await runRequest(sentence, controller.signal, receivedAt);
        results.push(report);
        if (report.status !== "done") break;
      }
    } finally {
      if (active === controller) active = undefined;
      finish(call.callId, results);
    }
  }

  return {
    handle(call: ToolCall): void {
      if (known.has(call.callId) || completed.includes(call.callId)) return;
      const receivedAt = Date.now();
      if (queued >= queueLimit) {
        // A refused call never becomes the active one, so it leaves the snapshot alone.
        submitReport(call.callId, [{ request: "", status: "queue_full" }]);
        return;
      }
      known.add(call.callId);
      queued += 1;
      publish();
      const startedGeneration = generation;
      chain = chain
        .then(() => run(call, receivedAt, startedGeneration))
        .catch((error: unknown) => {
          console.error("Voice runner failed to handle a tool call", error);
        });
    },
    interrupt(): void {
      active?.abort();
    },
    reset(): void {
      generation += 1;
      queued = 0;
      active?.abort();
      publish();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): RunnerSnapshot {
      return snapshot;
    },
  };
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof CapabilityRegistryError) return error.code === "cancelled";
  return error instanceof Error && error.name === "AbortError";
}
