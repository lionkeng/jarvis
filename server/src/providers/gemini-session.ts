import { renderGeminiPolicy } from "./demo-agent-policy.js";
import type { FetchLike } from "./openai-session.js";
import type { SessionPreferences } from "../session-preferences.js";

export const GEMINI_EXTENDED_MODEL = "gemini-3.8-live-extended-thinking";

const AUTH_TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
const LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const VOICE_NAME = "Kore";
const SESSION_LIFETIME_MS = 1_800_000;
const NEW_SESSION_LIFETIME_MS = 60_000;

export interface GeminiSessionPolicy {
  model: string;
  preferences: SessionPreferences;
}

export interface LiveTokenGrant {
  kind: "websocket-token";
  endpoint: string;
  token: string;
  setup: { setup: Record<string, unknown> };
  expiresAt: string;
}

export async function createGeminiLiveGrant(apiKey: string, policy: GeminiSessionPolicy, fetcher: FetchLike = fetch, now: () => number = Date.now): Promise<LiveTokenGrant> {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const issuedAt = now();
  const expiresAt = new Date(issuedAt + SESSION_LIFETIME_MS).toISOString();
  const setup = liveSetup(policy);
  const response = await fetcher(AUTH_TOKEN_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(issuedAt + NEW_SESSION_LIFETIME_MS).toISOString(),
      bidiGenerateContentSetup: setup,
    }),
  });
  if (!response.ok) throw new Error(`Gemini auth token request failed with status ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("name" in payload) || typeof payload.name !== "string" || !payload.name.trim()) {
    throw new Error("Invalid Gemini auth token response");
  }
  return { kind: "websocket-token", endpoint: LIVE_ENDPOINT, token: payload.name, setup: { setup }, expiresAt };
}

function liveSetup(policy: GeminiSessionPolicy): Record<string, unknown> {
  const extended = policy.model === GEMINI_EXTENDED_MODEL;
  const rendering = renderGeminiPolicy(policy.preferences, extended);
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
  };
  if (extended) generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
  return {
    model: `models/${policy.model}`,
    generationConfig,
    systemInstruction: { parts: [{ text: rendering.instruction }] },
    tools: [{ functionDeclarations: rendering.functionDeclarations }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
  };
}
