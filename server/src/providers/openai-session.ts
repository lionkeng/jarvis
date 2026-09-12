import type { ResponseTiming, SessionPreferences } from "../session-preferences.js";

export interface OpenAISessionPolicy {
  model: string;
  backendModel: string;
  maxOutputTokens: number;
  preferences: SessionPreferences;
}

export interface LiveSessionResponse {
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TIMING_INSTRUCTIONS: Record<ResponseTiming, string> = {
  fast: "Respond promptly and keep pauses short, while allowing the user to finish.",
  natural: "Use a natural conversational pace and allow the user to finish.",
  patient: "Give the user extra time to finish their thoughts before replying.",
};

const PERFORM_UI_ACTIONS_TOOL = {
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
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target"],
              properties: {
                type: { type: "string", enum: ["navigate"] },
                target: { type: "string", enum: ["dashboard", "library", "article", "settings"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target"],
              properties: {
                type: { type: "string", enum: ["open"] },
                target: { type: "string", enum: ["library.details"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target"],
              properties: {
                type: { type: "string", enum: ["close"] },
                target: { type: "string", enum: ["library.details"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target", "value"],
              properties: {
                type: { type: "string", enum: ["select"] },
                target: { type: "string", enum: ["library.item"] },
                value: { type: "string", enum: ["atlas", "beacon", "cinder"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target", "value"],
              properties: {
                type: { type: "string", enum: ["select"] },
                target: { type: "string", enum: ["settings.theme"] },
                value: { type: "string", enum: ["light", "dark", "system"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target", "direction"],
              properties: {
                type: { type: "string", enum: ["scroll"] },
                target: { type: "string", enum: ["article.content", "library.results"] },
                direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target"],
              properties: {
                type: { type: "string", enum: ["focus"] },
                target: { type: "string", enum: ["dashboard.search"] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target"],
              properties: {
                type: { type: "string", enum: ["activate"] },
                target: { type: "string", enum: ["article.bookmark"] },
              },
            },
          ],
        },
      },
    },
  },
} as const;

const BACKEND_INSTRUCTIONS = [
  "Answer. Direct informational answers use one or two short sentences unless the user asks for detail.",
  "Act. UI mutation requests call perform_ui_actions without a spoken preamble. Ordinary questions never call the UI tool.",
  "Navigate. Opening dashboard, library, article, or settings means navigation. open is reserved for the library details panel.",
  "Compound. A request containing several UI changes becomes one tool call with ordered actions.",
  "Scroll. Unqualified scroll means one downward scroll on the named or implied page content. Explicit up, top, bottom, or down wording takes precedence.",
  "Example. Open article and scroll means navigate to the article and then scroll article.content down in the same call.",
  "Clarify. Ask at most one short clarification only when a required target or value truly cannot be inferred from the closed demo grammar.",
  "Result. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.",
  "Schema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or targets outside the tool schema.",
].join("\n");

export async function createOpenAILiveSession(apiKey: string, sdp: string, policy: OpenAISessionPolicy, fetcher: FetchLike = fetch): Promise<LiveSessionResponse> {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetcher("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      session: {
        model: policy.model,
        audio: { output: { voice: "marin" } },
        instructions: [
          "Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.",
          "Delegate every UI change to the backend without a spoken preamble. Delegate requests needing reasoning or information you do not know.",
          "Only announce UI success after the backend verifies it, in one short sentence without internal action names, IDs, JSON, or action counts.",
          "For a failed action, explain briefly. For a cancelled action, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.",
          TIMING_INSTRUCTIONS[policy.preferences.responseTiming],
          `Aim for a speaking pace of ${policy.preferences.speechRate} times normal.`,
        ].join("\n"),
        delegation: {
          type: "responses",
          responses: {
            model: policy.backendModel,
            max_output_tokens: policy.maxOutputTokens,
            reasoning: { effort: "low" },
            tools: [PERFORM_UI_ACTIONS_TOOL],
            tool_choice: "auto",
            parallel_tool_calls: false,
            instructions: BACKEND_INSTRUCTIONS + "\nReturn concise verified facts for the voice model. After a function result, summarize it without repeating the operation. Report cancellation as cancelled and do not retry it.",
          },
        },
      },
      transport: { type: "webrtc", sdp },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Live session request failed with status ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("session" in payload) || !("transport" in payload)) throw new Error("Invalid Live session response");
  const { session, transport } = payload;
  if (!session || typeof session !== "object" || !("id" in session) || typeof session.id !== "string" || !session.id.trim()
    || !transport || typeof transport !== "object" || !("type" in transport) || transport.type !== "webrtc"
    || !("sdp" in transport) || typeof transport.sdp !== "string" || !transport.sdp.trim()) throw new Error("Invalid Live session response");
  return { session: { id: session.id }, transport: { type: "webrtc", sdp: transport.sdp } };
}
