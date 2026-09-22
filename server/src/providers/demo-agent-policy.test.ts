import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderGeminiPolicy, renderOpenAIPolicy } from "./demo-agent-policy.js";

const preferences = { responseTiming: "natural", speechRate: 1 } as const;

const RETIRED_TOOL_NAME = "perform_ui_actions";

const TOOL_DESCRIPTION = "Apply one or more changes to the app's screen. Each entry in requests is one self-contained imperative English sentence describing one change, in the order to apply them. Keep the user's size, color, and ordinal words. Resolve pronouns and references from the conversation. Split a compound request into one sentence per change. Translate other languages to English.";

const TODAYS_TOOL = {
  type: "function",
  name: "request_ui_changes",
  strict: false,
  description: TOOL_DESCRIPTION,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["requests"],
    properties: {
      requests: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", minLength: 1 },
      },
    },
  },
};

const TODAYS_GEMINI_DECLARATION = {
  name: "request_ui_changes",
  description: TOOL_DESCRIPTION,
  parameters: {
    type: "object",
    required: ["requests"],
    properties: {
      requests: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string" },
      },
    },
  },
};

const TODAYS_REQUEST_RULES = [
  "Answer. Direct informational answers use one or two short sentences unless the user asks for detail.",
  "Act. UI change requests call request_ui_changes without a spoken preamble. Ordinary questions never call it.",
  "Sentences. Each request is one self-contained imperative English sentence naming what to change and how, such as 'select the Atlas card' or 'scroll the article to the bottom'. Keep the user's size words, color words, and ordinals. Name the page, card, panel, or setting plainly, as the user did, and never fold one change into another.",
  "Compound. A request with several UI changes becomes one call with one sentence per change, in order.",
  "Example. 'Open the article and scroll to the bottom' becomes two sentences: 'go to the article page' and 'scroll the article to the bottom'.",
  "Clarify. When a result's status is unclear, ask the user the question in the result's message. When they answer, send a new self-contained sentence. Ask at most one clarification.",
  "Result. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.",
  "Schema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or control names. Describe the change in words.",
];

const TODAYS_VOICE_INSTRUCTIONS = [
  "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
  "Delegate every UI change to the backend without a spoken preamble. Delegate requests needing reasoning or information you do not know.",
  "Only announce UI success after the backend verifies it, in one short sentence without internal control names, IDs, JSON, or request counts.",
  "For a failed request, explain briefly. For a cancelled request, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.",
  "Use a natural conversational pace and allow the user to finish.",
  "Aim for a speaking pace of 1 times normal.",
].join("\n");

const TODAYS_BACKEND_INSTRUCTIONS = [
  ...TODAYS_REQUEST_RULES,
  "Return concise verified facts for the voice model. After a function result, summarize it without repeating the operation. Report cancellation as cancelled and do not retry it.",
].join("\n");

const TODAYS_GEMINI_INSTRUCTION = [
  "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
  "Only announce UI success after a successful tool result, in one short sentence without internal control names, IDs, JSON, or request counts.",
  "For a failed request, explain briefly. For a cancelled request, do not volunteer an acknowledgement.",
  ...TODAYS_REQUEST_RULES,
  "Use a natural conversational pace and allow the user to finish.",
  "Aim for a speaking pace of 1 times normal.",
].join("\n");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("renderOpenAIPolicy", () => {
  test("renders today's tool JSON with today's key order", () => {
    expect(JSON.stringify(renderOpenAIPolicy(preferences).tool)).toBe(JSON.stringify(TODAYS_TOOL));
  });

  test("renders today's voice and backend instructions", () => {
    const rendering = renderOpenAIPolicy(preferences);
    expect(rendering.instructions).toBe(TODAYS_VOICE_INSTRUCTIONS);
    expect(rendering.backendInstructions).toBe(TODAYS_BACKEND_INSTRUCTIONS);
  });

  test("carries the response timing and speech rate preferences", () => {
    const rendering = renderOpenAIPolicy({ responseTiming: "patient", speechRate: 0.9 });
    expect(rendering.instructions).toContain("extra time");
    expect(rendering.instructions).toContain("0.9 times normal");
  });
});

describe("renderGeminiPolicy", () => {
  test("renders today's function declaration with today's key order", () => {
    const [declaration] = renderGeminiPolicy(preferences, false).functionDeclarations;
    expect(JSON.stringify(declaration)).toBe(JSON.stringify(TODAYS_GEMINI_DECLARATION));
  });

  test("instructs the model directly with no delegation wording", () => {
    const { instruction } = renderGeminiPolicy(preferences, false);
    expect(instruction).toBe(TODAYS_GEMINI_INSTRUCTION);
    expect(instruction).not.toContain("backend");
    expect(instruction).not.toContain("Delegate");
  });

  test("adds the non-blocking behavior and the await rule on the extended model", () => {
    const rendering = renderGeminiPolicy(preferences, true);
    expect(JSON.stringify(rendering.functionDeclarations[0])).toBe(JSON.stringify({ ...TODAYS_GEMINI_DECLARATION, behavior: "NON_BLOCKING" }));
    expect(rendering.instruction).toBe([
      TODAYS_GEMINI_INSTRUCTION.split("\nUse a natural conversational pace")[0],
      "Await. Say nothing about a UI change until its tool result arrives.",
      "Use a natural conversational pace and allow the user to finish.",
      "Aim for a speaking pace of 1 times normal.",
    ].join("\n"));
    expect(rendering.instruction).not.toContain("backend");
  });
});

describe("the retired tool", () => {
  test("appears in no rendering of either provider policy", () => {
    const renderings: unknown[] = [
      renderOpenAIPolicy(preferences),
      renderOpenAIPolicy({ responseTiming: "fast", speechRate: 1.2 }),
      renderGeminiPolicy(preferences, false),
      renderGeminiPolicy(preferences, true),
    ];
    for (const rendering of renderings) expect(JSON.stringify(rendering)).not.toContain(RETIRED_TOOL_NAME);
  });

  test("appears in no server source file", () => {
    const files = sourceFiles(join(import.meta.dir, ".."));
    expect(files.length).toBeGreaterThan(5);
    const naming = files.filter((file) => readFileSync(file, "utf8").includes(RETIRED_TOOL_NAME));
    expect(naming).toEqual([]);
  });
});
