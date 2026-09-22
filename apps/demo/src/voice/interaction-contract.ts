import type { RealtimeToolCall } from "@jarvis-viz/core";

export const PERFORM_UI_ACTIONS_TOOL = "perform_ui_actions";
export const MIN_ACTIONS_PER_CALL = 1;
export const MAX_ACTIONS_PER_CALL = 5;
export const INTERACTION_QUEUE_LIMIT = 8;
export const COMPLETED_CALL_ID_LIMIT = 64;
export const CAPABILITY_READY_TIMEOUT_MS = 2_000;

export const ROUTE_IDS = ["dashboard", "library", "article", "settings"] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export type UiCommand =
  | { type: "navigate"; route: RouteId }
  | { type: "open" | "close"; target: "library.details" }
  | { type: "select"; target: "library.item"; value: "atlas" | "beacon" | "cinder" }
  | { type: "select"; target: "settings.theme"; value: "light" | "dark" | "system" }
  | { type: "scroll"; target: "article.content" | "library.results"; direction: "up" | "down" | "top" | "bottom" }
  | { type: "focus"; target: "dashboard.search" }
  | { type: "activate"; target: "article.bookmark" };

export type InteractionFailureCode =
  | "invalid_arguments"
  | "target_unavailable"
  | "cancelled"
  | "execution_failed"
  | "queue_full";

export type UiCommandBatchSuccess = {
  ok: true;
  message: string;
  applied: UiCommand[];
};

export type UiCommandBatchFailure = {
  ok: false;
  message: string;
  applied: UiCommand[];
  code: InteractionFailureCode;
  actionIndex?: number;
};

export type UiCommandBatchResult = UiCommandBatchSuccess | UiCommandBatchFailure;

export type InteractionRequest =
  | { source: "voice"; call: RealtimeToolCall }
  | { source: "pointer" | "keyboard"; commands: UiCommand[] };

export type ParseToolCallResult =
  | { ok: true; commands: UiCommand[] }
  | { ok: false; result: UiCommandBatchFailure };

export const FAILURE_MESSAGES: Record<InteractionFailureCode, string> = {
  invalid_arguments: "The UI command arguments are invalid.",
  target_unavailable: "The UI target is not available.",
  cancelled: "The UI command was cancelled.",
  execution_failed: "The UI command failed.",
  queue_full: "The UI command queue is full.",
};

export function successResult(applied: UiCommand[]): UiCommandBatchSuccess {
  return {
    ok: true,
    message: spokenSuccess(applied),
    applied,
  };
}

export function toWireAction(command: UiCommand): Record<string, unknown> {
  switch (command.type) {
    case "navigate":
      return { type: "navigate", target: command.route };
    case "open":
    case "close":
      return { type: command.type, target: command.target };
    case "select":
      return { type: "select", target: command.target, value: command.value };
    case "scroll":
      return { type: "scroll", target: command.target, direction: command.direction };
    case "focus":
      return { type: "focus", target: command.target };
    case "activate":
      return { type: "activate", target: command.target };
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

export function serializeBatchResult(result: UiCommandBatchResult): string {
  return JSON.stringify({
    ...result,
    applied: result.applied.map(toWireAction),
  });
}

export function failureResult(
  code: InteractionFailureCode,
  applied: UiCommand[],
  actionIndex?: number,
): UiCommandBatchFailure {
  const result: UiCommandBatchFailure = {
    ok: false,
    message: FAILURE_MESSAGES[code],
    applied,
    code,
  };
  if (actionIndex !== undefined) result.actionIndex = actionIndex;
  return result;
}

export function parseToolCall(call: RealtimeToolCall): ParseToolCallResult {
  if (call.name !== PERFORM_UI_ACTIONS_TOOL) {
    return { ok: false, result: failureResult("invalid_arguments", []) };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(call.argumentsJson);
  } catch {
    return { ok: false, result: failureResult("invalid_arguments", []) };
  }
  if (!isPlainObject(payload) || !hasExactKeys(payload, ["actions"])) {
    return { ok: false, result: failureResult("invalid_arguments", []) };
  }
  const { actions } = payload;
  if (!Array.isArray(actions) || actions.length < MIN_ACTIONS_PER_CALL || actions.length > MAX_ACTIONS_PER_CALL) {
    return { ok: false, result: failureResult("invalid_arguments", []) };
  }
  const commands: UiCommand[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const entry = actions[index];
    if (!isPlainObject(entry)) {
      return { ok: false, result: failureResult("invalid_arguments", [], index) };
    }
    const command = parseAction(entry);
    if (command === undefined) {
      return { ok: false, result: failureResult("invalid_arguments", [], index) };
    }
    commands.push(command);
  }
  return { ok: true, commands };
}

function parseAction(entry: Record<string, unknown>): UiCommand | undefined {
  switch (entry.type) {
    case "navigate":
      return parseNavigate(entry);
    case "open":
      return parseOpenClose("open", entry);
    case "close":
      return parseOpenClose("close", entry);
    case "select":
      return parseSelect(entry);
    case "scroll":
      return parseScroll(entry);
    case "focus":
      return parseFocus(entry);
    case "activate":
      return parseActivate(entry);
    default:
      return undefined;
  }
}

function parseNavigate(entry: Record<string, unknown>): UiCommand | undefined {
  if (!hasExactKeys(entry, ["type", "target"])) return undefined;
  if (!isRouteId(entry.target)) return undefined;
  return { type: "navigate", route: entry.target };
}

function parseOpenClose(type: "open" | "close", entry: Record<string, unknown>): UiCommand | undefined {
  if (!hasExactKeys(entry, ["type", "target"])) return undefined;
  if (entry.target !== "library.details") return undefined;
  return { type, target: "library.details" };
}

function parseSelect(entry: Record<string, unknown>): UiCommand | undefined {
  if (!hasExactKeys(entry, ["type", "target", "value"])) return undefined;
  if (entry.target === "library.item") {
    if (entry.value === "atlas" || entry.value === "beacon" || entry.value === "cinder") {
      return { type: "select", target: "library.item", value: entry.value };
    }
    return undefined;
  }
  if (entry.target === "settings.theme") {
    if (entry.value === "light" || entry.value === "dark" || entry.value === "system") {
      return { type: "select", target: "settings.theme", value: entry.value };
    }
    return undefined;
  }
  return undefined;
}

function parseScroll(entry: Record<string, unknown>): UiCommand | undefined {
  if (!hasExactKeys(entry, ["type", "target", "direction"])) return undefined;
  if (entry.target !== "article.content" && entry.target !== "library.results") return undefined;
  if (entry.direction !== "up" && entry.direction !== "down" && entry.direction !== "top" && entry.direction !== "bottom") {
    return undefined;
  }
  return { type: "scroll", target: entry.target, direction: entry.direction };
}

function parseFocus(entry: Record<string, unknown>): UiCommand | undefined {
  if (!hasExactKeys(entry, ["type", "target"])) return undefined;
  if (entry.target !== "dashboard.search") return undefined;
  return { type: "focus", target: "dashboard.search" };
}

function parseActivate(entry: Record<string, unknown>): UiCommand | undefined {
  if (!hasExactKeys(entry, ["type", "target"])) return undefined;
  if (entry.target !== "article.bookmark") return undefined;
  return { type: "activate", target: "article.bookmark" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

function spokenSuccess(applied: UiCommand[]): string {
  const parts = applied.map(spokenCommand);
  if (parts.length === 0) return "Done.";
  const first = parts[0];
  const second = parts[1];
  if (parts.length === 1 && first !== undefined) return first;
  if (parts.length === 2 && first !== undefined && second !== undefined) {
    return `${first.slice(0, -1)} and ${second[0]?.toLowerCase() ?? ""}${second.slice(1)}`;
  }
  return "Done.";
}

function spokenCommand(command: UiCommand): string {
  switch (command.type) {
    case "navigate":
      return `Opened the ${command.route}.`;
    case "open":
      return "Opened library details.";
    case "close":
      return "Closed library details.";
    case "select":
      return command.target === "library.item" ? `Selected ${command.value}.` : `Set ${command.value} theme.`;
    case "scroll":
      switch (command.direction) {
        case "down":
          return "Scrolled down.";
        case "up":
          return "Scrolled up.";
        case "top":
          return "Scrolled to the top.";
        case "bottom":
          return "Scrolled to the bottom.";
        default: {
          const _exhaustive: never = command.direction;
          return _exhaustive;
        }
      }
    case "focus":
      return "Focused search.";
    case "activate":
      return "Toggled the bookmark.";
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

function isRouteId(value: unknown): value is RouteId {
  if (typeof value !== "string") return false;
  switch (value) {
    case "dashboard":
    case "library":
    case "article":
    case "settings":
      return true;
    default:
      return false;
  }
}
