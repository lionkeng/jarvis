import type { ResponseTiming, SessionPreferences } from "../session-preferences.js";

export interface OpenAISessionPolicy {
  model: string;
  maxOutputTokens: number;
  contextTokenLimit: number;
  preferences: SessionPreferences;
  realtimeTracing: boolean;
}

export interface ClientSecretResponse {
  value: string;
  expires_at?: number;
  [key: string]: unknown;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TIMING_POLICY: Record<ResponseTiming, {
  reasoningEffort: "minimal" | "low" | "medium";
  vadEagerness: "high" | "auto" | "low";
  transcriptionDelay: "low" | "medium" | "high";
}> = {
  fast: { reasoningEffort: "minimal", vadEagerness: "high", transcriptionDelay: "low" },
  natural: { reasoningEffort: "low", vadEagerness: "auto", transcriptionDelay: "medium" },
  patient: { reasoningEffort: "medium", vadEagerness: "low", transcriptionDelay: "high" },
};

const TRANSCRIPTION_LANGUAGE = "zh";

const PERFORM_UI_ACTIONS_TOOL = {
  type: "function",
  name: "perform_ui_actions",
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

const SESSION_INSTRUCTIONS = [
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

export async function createOpenAIClientSecret(apiKey: string, policy: OpenAISessionPolicy, fetcher: FetchLike = fetch, now: () => number = Date.now): Promise<ClientSecretResponse> {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const timing = TIMING_POLICY[policy.preferences.responseTiming];
  const response = await fetcher("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: policy.model,
        output_modalities: ["audio"],
        max_output_tokens: policy.maxOutputTokens,
        reasoning: { effort: timing.reasoningEffort },
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: {
              model: "gpt-realtime-whisper",
              language: TRANSCRIPTION_LANGUAGE,
              delay: timing.transcriptionDelay,
            },
            turn_detection: { type: "semantic_vad", eagerness: timing.vadEagerness, create_response: true, interrupt_response: true },
          },
          output: { voice: "echo", speed: policy.preferences.speechRate },
        },
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.8,
          token_limits: { post_instructions: policy.contextTokenLimit },
        },
        tools: [PERFORM_UI_ACTIONS_TOOL],
        tool_choice: "auto",
        parallel_tool_calls: false,
        tracing: policy.realtimeTracing ? "auto" : null,
        instructions: SESSION_INSTRUCTIONS,
      },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI client-secret request failed with status ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  const nested = payload.client_secret && typeof payload.client_secret === "object" ? payload.client_secret as Record<string, unknown> : undefined;
  const value = typeof payload.value === "string" ? payload.value : typeof nested?.value === "string" ? nested.value : undefined;
  if (!value) throw new Error("OpenAI returned a client-secret response without a token");
  const expires = typeof payload.expires_at === "number" ? payload.expires_at : typeof nested?.expires_at === "number" ? nested.expires_at : undefined;
  if (expires !== undefined && expires <= Math.floor(now() / 1000)) throw new Error("OpenAI returned an already-expired client secret");
  return expires === undefined ? { ...payload, value } : { ...payload, value, expires_at: expires };
}
