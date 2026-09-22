import type { ResponseTiming, SessionPreferences } from "../session-preferences.js";

const TOOL_NAME = "request_ui_changes";

const TOOL_DESCRIPTION = "Apply one or more changes to the app's screen. Each entry in requests is one self-contained imperative English sentence describing one change, in the order to apply them. Keep the user's size, color, and ordinal words. Resolve pronouns and references from the conversation. Split a compound request into one sentence per change. Translate other languages to English.";

const REQUEST_RULES = [
  "Answer. Direct informational answers use one or two short sentences unless the user asks for detail.",
  `Act. UI change requests call ${TOOL_NAME} without a spoken preamble. Ordinary questions never call it.`,
  "Sentences. Each request is one self-contained imperative English sentence naming what to change and how, such as 'select the Atlas card' or 'scroll the article to the bottom'. Keep the user's size words, color words, and ordinals. Name the page, card, panel, or setting plainly, as the user did, and never fold one change into another.",
  "Compound. A request with several UI changes becomes one call with one sentence per change, in order.",
  "Example. 'Open the article and scroll to the bottom' becomes two sentences: 'go to the article page' and 'scroll the article to the bottom'.",
  "Clarify. When a result's status is unclear, ask the user the question in the result's message. When they answer, send a new self-contained sentence. Ask at most one clarification.",
  "Result. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.",
  "Schema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or control names. Describe the change in words.",
];

const TIMING_INSTRUCTIONS: Record<ResponseTiming, string> = {
  fast: "Respond promptly and keep pauses short, while allowing the user to finish.",
  natural: "Use a natural conversational pace and allow the user to finish.",
  patient: "Give the user extra time to finish their thoughts before replying.",
};

const MIN_REQUESTS = 1;
const MAX_REQUESTS = 5;

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
      "Only announce UI success after the backend verifies it, in one short sentence without internal control names, IDs, JSON, or request counts.",
      "For a failed request, explain briefly. For a cancelled request, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.",
      TIMING_INSTRUCTIONS[preferences.responseTiming],
      `Aim for a speaking pace of ${preferences.speechRate} times normal.`,
    ].join("\n"),
    backendInstructions: [
      ...REQUEST_RULES,
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
        required: ["requests"],
        properties: {
          requests: {
            type: "array",
            minItems: MIN_REQUESTS,
            maxItems: MAX_REQUESTS,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

export function renderGeminiPolicy(preferences: SessionPreferences, nonBlocking: boolean): GeminiPolicyRendering {
  const declaration: Record<string, unknown> = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      required: ["requests"],
      properties: {
        requests: {
          type: "array",
          minItems: MIN_REQUESTS,
          maxItems: MAX_REQUESTS,
          items: { type: "string" },
        },
      },
    },
  };
  if (nonBlocking) declaration.behavior = "NON_BLOCKING";
  return {
    instruction: [
      "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
      "Only announce UI success after a successful tool result, in one short sentence without internal control names, IDs, JSON, or request counts.",
      "For a failed request, explain briefly. For a cancelled request, do not volunteer an acknowledgement.",
      ...REQUEST_RULES,
      ...(nonBlocking ? ["Await. Say nothing about a UI change until its tool result arrives."] : []),
      TIMING_INSTRUCTIONS[preferences.responseTiming],
      `Aim for a speaking pace of ${preferences.speechRate} times normal.`,
    ].join("\n"),
    functionDeclarations: [declaration],
  };
}
