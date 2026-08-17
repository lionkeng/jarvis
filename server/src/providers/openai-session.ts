import type { ResponseTiming, SessionPreferences } from "../session-preferences.js";

export interface OpenAISessionPolicy {
  model: string;
  maxOutputTokens: number;
  contextTokenLimit: number;
  preferences: SessionPreferences;
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
          output: { voice: "marin", speed: policy.preferences.speechRate },
        },
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.8,
          token_limits: { post_instructions: policy.contextTokenLimit },
        },
        instructions: "You are a concise voice assistant. Prefer short spoken answers unless the user asks for detail.",
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
