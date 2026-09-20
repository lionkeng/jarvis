import type { ResponseTiming, SessionPreferences } from "../session-preferences.js";

interface ActionRule {
  type: string;
  targets: string[];
  values?: string[];
  directions?: string[];
}

const TOOL_NAME = "perform_ui_actions";

const TOOL_DESCRIPTION = "Put every ordered action for one user request in a single call. Navigate goes to a page. Open and close only the library details panel. Select library items or themes, scroll named regions, focus dashboard search, or activate the article bookmark.";

const ACTION_GRAMMAR: ActionRule[] = [
  { type: "navigate", targets: ["dashboard", "library", "article", "settings"] },
  { type: "open", targets: ["library.details"] },
  { type: "close", targets: ["library.details"] },
  { type: "select", targets: ["library.item"], values: ["atlas", "beacon", "cinder"] },
  { type: "select", targets: ["settings.theme"], values: ["light", "dark", "system"] },
  { type: "scroll", targets: ["article.content", "library.results"], directions: ["up", "down", "top", "bottom"] },
  { type: "focus", targets: ["dashboard.search"] },
  { type: "activate", targets: ["article.bookmark"] },
];

const ACTION_RULES = [
  "Answer. Direct informational answers use one or two short sentences unless the user asks for detail.",
  `Act. UI mutation requests call ${TOOL_NAME} without a spoken preamble. Ordinary questions never call the UI tool.`,
  "Navigate. Opening dashboard, library, article, or settings means navigation. open is reserved for the library details panel.",
  "Compound. A request containing several UI changes becomes one tool call with ordered actions.",
  "Scroll. Unqualified scroll means one downward scroll on the named or implied page content. Explicit up, top, bottom, or down wording takes precedence.",
  "Example. Open article and scroll means navigate to the article and then scroll article.content down in the same call.",
  "Clarify. Ask at most one short clarification only when a required target or value truly cannot be inferred from the closed demo grammar.",
  "Result. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.",
  "Schema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or targets outside the tool schema.",
];

const TIMING_INSTRUCTIONS: Record<ResponseTiming, string> = {
  fast: "Respond promptly and keep pauses short, while allowing the user to finish.",
  natural: "Use a natural conversational pace and allow the user to finish.",
  patient: "Give the user extra time to finish their thoughts before replying.",
};

const MIN_ACTIONS = 1;
const MAX_ACTIONS = 5;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const ACTION_TYPES = unique(ACTION_GRAMMAR.map((rule) => rule.type));
const ACTION_TARGETS = unique(ACTION_GRAMMAR.flatMap((rule) => rule.targets));
const ACTION_VALUES = unique(ACTION_GRAMMAR.flatMap((rule) => rule.values ?? []));
const ACTION_DIRECTIONS = unique(ACTION_GRAMMAR.flatMap((rule) => rule.directions ?? []));

export interface OpenAIPolicyRendering {
  instructions: string;
  backendInstructions: string;
  tool: Record<string, unknown>;
}

export interface GeminiPolicyRendering {
  instruction: string;
  functionDeclarations: Record<string, unknown>[];
}

export function renderOpenAIPolicy(preferences: SessionPreferences): OpenAIPolicyRendering {
  return {
    instructions: [
      "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
      "Delegate every UI change to the backend without a spoken preamble. Delegate requests needing reasoning or information you do not know.",
      "Only announce UI success after the backend verifies it, in one short sentence without internal action names, IDs, JSON, or action counts.",
      "For a failed action, explain briefly. For a cancelled action, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.",
      TIMING_INSTRUCTIONS[preferences.responseTiming],
      `Aim for a speaking pace of ${preferences.speechRate} times normal.`,
    ].join("\n"),
    backendInstructions: [
      ...ACTION_RULES,
      "Return concise verified facts for the voice model. After a function result, summarize it without repeating the operation. Report cancellation as cancelled and do not retry it.",
    ].join("\n"),
    tool: {
      type: "function",
      name: TOOL_NAME,
      strict: false,
      description: TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["actions"],
        properties: {
          actions: {
            type: "array",
            minItems: MIN_ACTIONS,
            maxItems: MAX_ACTIONS,
            items: { oneOf: ACTION_GRAMMAR.map(openAIVariant) },
          },
        },
      },
    },
  };
}

export function renderGeminiPolicy(preferences: SessionPreferences, nonBlocking: boolean): GeminiPolicyRendering {
  const declaration: Record<string, unknown> = {
    name: TOOL_NAME,
    description: [TOOL_DESCRIPTION, ...ACTION_GRAMMAR.map(grammarSentence)].join(" "),
    parameters: {
      type: "object",
      required: ["actions"],
      properties: {
        actions: {
          type: "array",
          minItems: MIN_ACTIONS,
          maxItems: MAX_ACTIONS,
          items: {
            type: "object",
            required: ["type", "target"],
            properties: {
              type: { type: "string", enum: ACTION_TYPES },
              target: { type: "string", enum: ACTION_TARGETS },
              value: { type: "string", enum: ACTION_VALUES },
              direction: { type: "string", enum: ACTION_DIRECTIONS },
            },
          },
        },
      },
    },
  };
  if (nonBlocking) declaration.behavior = "NON_BLOCKING";
  return {
    instruction: [
      "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
      "Only announce UI success after a successful tool result, in one short sentence without internal action names, IDs, JSON, or action counts.",
      "For a failed action, explain briefly. For a cancelled action, do not volunteer an acknowledgement.",
      ...ACTION_RULES,
      ...(nonBlocking ? ["Await. Say nothing about a UI action until its tool result arrives."] : []),
      TIMING_INSTRUCTIONS[preferences.responseTiming],
      `Aim for a speaking pace of ${preferences.speechRate} times normal.`,
    ].join("\n"),
    functionDeclarations: [declaration],
  };
}

function openAIVariant(rule: ActionRule): Record<string, unknown> {
  const required = ["type", "target"];
  const properties: Record<string, unknown> = {
    type: { type: "string", enum: [rule.type] },
    target: { type: "string", enum: rule.targets },
  };
  if (rule.values) {
    required.push("value");
    properties.value = { type: "string", enum: rule.values };
  }
  if (rule.directions) {
    required.push("direction");
    properties.direction = { type: "string", enum: rule.directions };
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function grammarSentence(rule: ActionRule): string {
  const value = rule.values ? ` and value ${rule.values.join(", ")}` : "";
  const direction = rule.directions ? ` and direction ${rule.directions.join(", ")}` : "";
  return `${rule.type} takes target ${rule.targets.join(", ")}${value}${direction}.`;
}
