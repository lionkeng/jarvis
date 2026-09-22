import { describe, expect, test } from "bun:test";
import { renderGeminiPolicy, renderOpenAIPolicy } from "./demo-agent-policy.js";

const preferences = { responseTiming: "natural", speechRate: 1 } as const;

const TODAYS_TOOL = {
  type: "function",
  name: "perform_ui_actions",
  strict: false,
  description: "Put every ordered action for one user request in a single call. Navigate goes to a page. Open and close only the library details panel. Select library items or themes, scroll named regions, focus dashboard search, or activate the article bookmark.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["actions"],
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["type", "target"], properties: { type: { type: "string", enum: ["navigate"] }, target: { type: "string", enum: ["dashboard", "library", "article", "settings"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target"], properties: { type: { type: "string", enum: ["open"] }, target: { type: "string", enum: ["library.details"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target"], properties: { type: { type: "string", enum: ["close"] }, target: { type: "string", enum: ["library.details"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target", "value"], properties: { type: { type: "string", enum: ["select"] }, target: { type: "string", enum: ["library.item"] }, value: { type: "string", enum: ["atlas", "beacon", "cinder"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target", "value"], properties: { type: { type: "string", enum: ["select"] }, target: { type: "string", enum: ["settings.theme"] }, value: { type: "string", enum: ["light", "dark", "system"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target", "direction"], properties: { type: { type: "string", enum: ["scroll"] }, target: { type: "string", enum: ["article.content", "library.results"] }, direction: { type: "string", enum: ["up", "down", "top", "bottom"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target"], properties: { type: { type: "string", enum: ["focus"] }, target: { type: "string", enum: ["dashboard.search"] } } },
            { type: "object", additionalProperties: false, required: ["type", "target"], properties: { type: { type: "string", enum: ["activate"] }, target: { type: "string", enum: ["article.bookmark"] } } },
          ],
        },
      },
    },
  },
};

const TODAYS_VOICE_INSTRUCTIONS = [
  "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
  "Delegate every UI change to the backend without a spoken preamble. Delegate requests needing reasoning or information you do not know.",
  "Only announce UI success after the backend verifies it, in one short sentence without internal action names, IDs, JSON, or action counts.",
  "For a failed action, explain briefly. For a cancelled action, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.",
  "Use a natural conversational pace and allow the user to finish.",
  "Aim for a speaking pace of 1 times normal.",
].join("\n");

const TODAYS_BACKEND_INSTRUCTIONS = [
  "Answer. Direct informational answers use one or two short sentences unless the user asks for detail.",
  "Act. UI mutation requests call perform_ui_actions without a spoken preamble. Ordinary questions never call the UI tool.",
  "Navigate. Opening dashboard, library, article, or settings means navigation. open is reserved for the library details panel.",
  "Compound. A request containing several UI changes becomes one tool call with ordered actions.",
  "Scroll. Unqualified scroll means one downward scroll on the named or implied page content. Explicit up, top, bottom, or down wording takes precedence.",
  "Example. Open article and scroll means navigate to the article and then scroll article.content down in the same call.",
  "Clarify. Ask at most one short clarification only when a required target or value truly cannot be inferred from the closed demo grammar.",
  "Result. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.",
  "Schema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or targets outside the tool schema.",
  "Return concise verified facts for the voice model. After a function result, summarize it without repeating the operation. Report cancellation as cancelled and do not retry it.",
].join("\n");

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
  test("instructs the model directly with no delegation wording", () => {
    const { instruction } = renderGeminiPolicy(preferences, false);
    expect(instruction).not.toContain("backend");
    expect(instruction).not.toContain("Delegate");
    expect(instruction).toContain("Schema. Never invent CSS selectors");
    expect(instruction).toContain("Use a natural conversational pace");
    expect(instruction).toContain("1 times normal");
  });

  test("flattens the canonical grammar into one action object", () => {
    const [declaration] = renderGeminiPolicy(preferences, false).functionDeclarations;
    expect(declaration).toBeDefined();
    const parameters = declaration!.parameters as { properties: { actions: { minItems: number; maxItems: number; items: { required: string[]; properties: Record<string, { enum: string[] }> } } } };
    const items = parameters.properties.actions.items;
    expect(declaration!.name).toBe("perform_ui_actions");
    expect(declaration!.behavior).toBeUndefined();
    expect(parameters.properties.actions.minItems).toBe(1);
    expect(parameters.properties.actions.maxItems).toBe(5);
    expect(items.required).toEqual(["type", "target"]);
    expect(items.properties.type?.enum).toEqual(["navigate", "open", "close", "select", "scroll", "focus", "activate"]);
    expect(items.properties.target?.enum).toEqual(["dashboard", "library", "article", "settings", "library.details", "library.item", "settings.theme", "article.content", "library.results", "dashboard.search", "article.bookmark"]);
    expect(items.properties.value?.enum).toEqual(["atlas", "beacon", "cinder", "light", "dark", "system"]);
    expect(items.properties.direction?.enum).toEqual(["up", "down", "top", "bottom"]);
    expect(declaration!.description).toContain("scroll takes target article.content, library.results and direction up, down, top, bottom.");
  });

  test("adds the non-blocking behavior and the await rule on the extended model", () => {
    const rendering = renderGeminiPolicy(preferences, true);
    expect(rendering.functionDeclarations[0]?.behavior).toBe("NON_BLOCKING");
    expect(rendering.instruction).toContain("Say nothing about a UI action until its tool result arrives");
    expect(rendering.instruction).not.toContain("backend");
  });
});
