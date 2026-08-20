import { assign, createActor, enqueueActions, fromPromise, setup } from "xstate";
import type { RealtimeToolCall, RealtimeToolFollowUpIntent, RealtimeToolResult } from "@jarvis-viz/core";
import {
  CapabilityRegistryError,
  type UiCapabilityRegistry,
} from "./capability-registry.js";
import {
  COMPLETED_CALL_ID_LIMIT,
  INTERACTION_QUEUE_LIMIT,
  MAX_ACTIONS_PER_CALL,
  MIN_ACTIONS_PER_CALL,
  failureResult,
  parseToolCall,
  serializeBatchResult,
  successResult,
  type InteractionRequest,
  type UiCommand,
  type UiCommandBatchFailure,
  type UiCommandBatchResult,
} from "./interaction-contract.js";

export type InteractionResultPort = {
  submit(result: RealtimeToolResult): void;
};

export type InteractionActorDeps = {
  registry: UiCapabilityRegistry;
  resultPort: InteractionResultPort;
};

export type InteractionEvent =
  | { type: "TOOL_CALL_RECEIVED"; call: RealtimeToolCall }
  | { type: "TYPED_REQUEST"; source: "pointer" | "keyboard"; commands: UiCommand[] }
  | { type: "VOICE_INTERRUPTED" }
  | { type: "SESSION_DISCONNECTED" };

export type InteractionContext = {
  registry: UiCapabilityRegistry;
  resultPort: InteractionResultPort;
  queue: InteractionRequest[];
  active: InteractionRequest | undefined;
  commands: UiCommand[];
  applied: UiCommand[];
  lastResult: UiCommandBatchResult | undefined;
  completedCallIds: string[];
  submittedCallIds: Set<string>;
  reportingFailed: boolean;
};

type ValidateOutput =
  | { status: "ok"; commands: UiCommand[] }
  | { status: "invalid"; result: UiCommandBatchFailure };

type ExecuteInput = {
  registry: UiCapabilityRegistry;
  commands: UiCommand[];
  applied: UiCommand[];
};

type ReportInput = {
  request: InteractionRequest | undefined;
  result: UiCommandBatchResult | undefined;
  resultPort: InteractionResultPort;
  submittedCallIds: Set<string>;
};

function isKnownVoiceCall(context: InteractionContext, callId: string): boolean {
  if (context.submittedCallIds.has(callId) || context.completedCallIds.includes(callId)) return true;
  if (context.active?.source === "voice" && context.active.call.callId === callId) return true;
  return context.queue.some((item) => item.source === "voice" && item.call.callId === callId);
}

function rememberCallId(ids: string[], callId: string): string[] {
  if (ids.includes(callId)) return ids;
  const next = [...ids, callId];
  return next.length <= COMPLETED_CALL_ID_LIMIT ? next : next.slice(next.length - COMPLETED_CALL_ID_LIMIT);
}

function validateQueuedRequest(request: InteractionRequest): ValidateOutput {
  switch (request.source) {
    case "voice": {
      const parsed = parseToolCall(request.call);
      if (!parsed.ok) return { status: "invalid", result: parsed.result };
      return { status: "ok", commands: parsed.commands };
    }
    case "pointer":
    case "keyboard": {
      if (request.commands.length < MIN_ACTIONS_PER_CALL || request.commands.length > MAX_ACTIONS_PER_CALL) {
        return { status: "invalid", result: failureResult("invalid_arguments", []) };
      }
      return { status: "ok", commands: request.commands };
    }
    default: {
      const _exhaustive: never = request;
      throw new Error(`Unexpected request ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function isCancelledError(error: unknown): boolean {
  if (error instanceof CapabilityRegistryError) return error.code === "cancelled";
  return error instanceof Error && error.name === "AbortError";
}

export async function executeCommandBatch(
  registry: UiCapabilityRegistry,
  commands: readonly UiCommand[],
  signal: AbortSignal,
  applied: UiCommand[],
): Promise<UiCommandBatchResult> {
  for (let index = 0; index < commands.length; index += 1) {
    if (signal.aborted) return failureResult("cancelled", applied, index);
    const command = commands[index];
    if (command === undefined) return failureResult("execution_failed", applied, index);
    try {
      await registry.execute(command, signal);
      applied.push(command);
    } catch (error) {
      if (signal.aborted || isCancelledError(error)) return failureResult("cancelled", applied, index);
      if (error instanceof CapabilityRegistryError) return failureResult(error.code, applied, index);
      return failureResult("execution_failed", applied, index);
    }
  }
  return successResult(applied);
}

function cancelledResult(context: InteractionContext): UiCommandBatchFailure {
  const nextIndex = context.applied.length;
  if (context.commands.length > nextIndex) return failureResult("cancelled", [...context.applied], nextIndex);
  return failureResult("cancelled", [...context.applied]);
}

function followUpFor(result: UiCommandBatchResult): RealtimeToolFollowUpIntent {
  if (result.ok) return "brief-acknowledgement";
  switch (result.code) {
    case "cancelled":
      return "none";
    case "invalid_arguments":
    case "target_unavailable":
    case "execution_failed":
    case "queue_full":
      return "default";
    default: {
      const _exhaustive: never = result.code;
      return _exhaustive;
    }
  }
}

function reportVoiceResult(input: ReportInput): void {
  const { request, result, resultPort, submittedCallIds } = input;
  if (!request || request.source !== "voice" || !result) return;
  const callId = request.call.callId;
  if (submittedCallIds.has(callId)) return;
  submittedCallIds.add(callId);
  resultPort.submit({
    callId,
    output: serializeBatchResult(result),
    followUp: followUpFor(result),
  });
}

function submitOverflowResult(context: InteractionContext, callId: string): void {
  if (context.submittedCallIds.has(callId)) return;
  const result = failureResult("queue_full", []);
  context.submittedCallIds.add(callId);
  context.resultPort.submit({
    callId,
    output: serializeBatchResult(result),
    followUp: followUpFor(result),
  });
}

function isOkValidation(output: unknown): output is { status: "ok"; commands: UiCommand[] } {
  return typeof output === "object" && output !== null && "status" in output && output.status === "ok" && "commands" in output && Array.isArray(output.commands);
}

function isInvalidValidation(output: unknown): output is { status: "invalid"; result: UiCommandBatchFailure } {
  return typeof output === "object" && output !== null && "status" in output && output.status === "invalid" && "result" in output;
}

function isBatchResult(output: unknown): output is UiCommandBatchResult {
  return typeof output === "object" && output !== null && "ok" in output && "applied" in output && Array.isArray(output.applied);
}

export function selectVoiceWorkPending(snapshot: { context: InteractionContext }): boolean {
  const { active, queue } = snapshot.context;
  if (active?.source === "voice") return true;
  return queue.some((request) => request.source === "voice");
}

export const interactionMachine = setup({
  types: {
    input: {} as InteractionActorDeps,
    context: {} as InteractionContext,
    events: {} as InteractionEvent,
  },
  actors: {
    validateRequest: fromPromise(async ({ input }: { input: InteractionRequest }) => validateQueuedRequest(input)),
    executeCommands: fromPromise(async ({ input, signal }: { input: ExecuteInput; signal: AbortSignal }) =>
      executeCommandBatch(input.registry, input.commands, signal, input.applied),
    ),
    reportResult: fromPromise(async ({ input }: { input: ReportInput }) => {
      reportVoiceResult(input);
    }),
  },
  guards: {
    hasQueued: ({ context }) => context.queue.length > 0,
    validationPassed: ({ event }) => "output" in event && isOkValidation(event.output),
  },
  actions: {
    dequeue: assign(({ context }) => {
      const [next, ...rest] = context.queue;
      return {
        queue: rest,
        active: next,
        commands: [] as UiCommand[],
        applied: [] as UiCommand[],
        lastResult: undefined,
        reportingFailed: false,
      };
    }),
    enqueueVoice: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "TOOL_CALL_RECEIVED") return;
      const callId = event.call.callId;
      if (isKnownVoiceCall(context, callId)) return;
      if (context.queue.length >= INTERACTION_QUEUE_LIMIT) {
        try {
          submitOverflowResult(context, callId);
        } catch {
          enqueue.assign({ reportingFailed: true, completedCallIds: rememberCallId(context.completedCallIds, callId) });
          return;
        }
        enqueue.assign({ completedCallIds: rememberCallId(context.completedCallIds, callId) });
        return;
      }
      enqueue.assign({
        queue: [...context.queue, { source: "voice" as const, call: event.call }],
      });
    }),
    enqueueTyped: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "TYPED_REQUEST") return;
      if (context.queue.length >= INTERACTION_QUEUE_LIMIT) return;
      enqueue.assign({
        queue: [...context.queue, { source: event.source, commands: event.commands }],
      });
    }),
    storeCommands: assign(({ event }) => {
      if (!("output" in event) || !isOkValidation(event.output)) return {};
      return { commands: event.output.commands, applied: [] as UiCommand[] };
    }),
    storeValidationFailure: assign(({ event }) => {
      if (!("output" in event) || !isInvalidValidation(event.output)) return {};
      return { lastResult: event.output.result, commands: [] as UiCommand[], applied: [] as UiCommand[] };
    }),
    storeExecutionResult: assign(({ event }) => {
      if (!("output" in event) || !isBatchResult(event.output)) return {};
      return { lastResult: event.output };
    }),
    markCancelled: assign(({ context }) => ({
      lastResult: cancelledResult(context),
    })),
    completeRequest: assign(({ context }) => {
      const active = context.active;
      const completedCallIds =
        active?.source === "voice" ? rememberCallId(context.completedCallIds, active.call.callId) : context.completedCallIds;
      return {
        active: undefined,
        commands: [] as UiCommand[],
        applied: [] as UiCommand[],
        completedCallIds,
      };
    }),
    markReportingFailed: assign(({ context }) => {
      const active = context.active;
      const completedCallIds =
        active?.source === "voice" ? rememberCallId(context.completedCallIds, active.call.callId) : context.completedCallIds;
      return {
        reportingFailed: true,
        active: undefined,
        commands: [] as UiCommand[],
        applied: [] as UiCommand[],
        completedCallIds,
      };
    }),
    onDisconnect: enqueueActions(({ context, enqueue }) => {
      const active = context.active;
      const lastResult = context.lastResult ?? (active ? cancelledResult(context) : undefined);
      if (active?.source === "voice" && lastResult && !context.submittedCallIds.has(active.call.callId)) {
        try {
          reportVoiceResult({
            request: active,
            result: lastResult,
            resultPort: context.resultPort,
            submittedCallIds: context.submittedCallIds,
          });
        } catch {
          enqueue.assign({ reportingFailed: true });
        }
      } else if (active?.source === "voice" && !context.submittedCallIds.has(active.call.callId)) {
        enqueue.assign({ reportingFailed: true });
      }
      enqueue.assign({
        queue: [],
        active: undefined,
        commands: [] as UiCommand[],
        applied: [] as UiCommand[],
        lastResult,
      });
    }),
  },
}).createMachine({
  id: "interaction",
  initial: "ready",
  context: ({ input }) => ({
    registry: input.registry,
    resultPort: input.resultPort,
    queue: [],
    active: undefined,
    commands: [],
    applied: [],
    lastResult: undefined,
    completedCallIds: [],
    submittedCallIds: new Set<string>(),
    reportingFailed: false,
  }),
  on: {
    TOOL_CALL_RECEIVED: { actions: "enqueueVoice" },
    TYPED_REQUEST: { actions: "enqueueTyped" },
    SESSION_DISCONNECTED: { target: ".ready", actions: "onDisconnect" },
  },
  states: {
    ready: {
      always: {
        guard: "hasQueued",
        target: "validating",
        actions: "dequeue",
      },
    },
    validating: {
      invoke: {
        src: "validateRequest",
        input: ({ context }) => {
          if (!context.active) throw new Error("validating without an active request");
          return context.active;
        },
        onDone: [
          {
            guard: "validationPassed",
            target: "executing",
            actions: "storeCommands",
          },
          {
            target: "reporting",
            actions: "storeValidationFailure",
          },
        ],
      },
      on: {
        VOICE_INTERRUPTED: { target: "reporting", actions: "markCancelled" },
      },
    },
    executing: {
      invoke: {
        src: "executeCommands",
        input: ({ context }) => ({
          registry: context.registry,
          commands: context.commands,
          applied: context.applied,
        }),
        onDone: {
          target: "reporting",
          actions: "storeExecutionResult",
        },
        onError: {
          target: "reporting",
          actions: assign(({ context, event }) => {
            const error = "error" in event ? event.error : undefined;
            const code = error instanceof CapabilityRegistryError ? error.code : "execution_failed";
            return { lastResult: failureResult(code, [...context.applied], context.applied.length) };
          }),
        },
      },
      on: {
        VOICE_INTERRUPTED: { target: "reporting", actions: "markCancelled" },
      },
    },
    reporting: {
      invoke: {
        src: "reportResult",
        input: ({ context }) => ({
          request: context.active,
          result: context.lastResult,
          resultPort: context.resultPort,
          submittedCallIds: context.submittedCallIds,
        }),
        onDone: { target: "ready", actions: "completeRequest" },
        onError: { target: "ready", actions: "markReportingFailed" },
      },
    },
  },
});

export function createInteractionActor(input: InteractionActorDeps) {
  return createActor(interactionMachine, { input });
}

export type InteractionActor = ReturnType<typeof createInteractionActor>;
