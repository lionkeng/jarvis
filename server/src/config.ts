import { LIVE_PROTOCOLS, type ProtocolId } from "./session-request.js";

export const GEMINI_LIVE_MODELS = ["gemini-3.8-live", "gemini-3.8-live-extended-thinking"] as const;

export interface OpenAIProviderConfig {
  protocol: "openai-live";
  apiKey: string;
  model: string;
  backendModel: string;
  maxOutputTokens: number;
}

export interface GeminiProviderConfig {
  protocol: "gemini-live";
  apiKey: string;
  model: string;
}

export type LiveProviderConfig = OpenAIProviderConfig | GeminiProviderConfig;

export interface TypeSafeConfig {
  apiKey: string;
  model: string;
}

export interface ServerConfig {
  providers: [LiveProviderConfig, ...LiveProviderConfig[]];
  allowedOrigins: string[];
  port: number;
  rateLimitRequests: number;
  rateLimitWindowMs: number;
  sessionBudgetRequests: number;
  sessionBudgetWindowMs: number;
  lifetimeStreamsPerOrigin: number;
  /** Absent when no TYPESAFE_API_KEY is set. The /interpret route then answers 503 and the rest of the server boots as before. */
  typesafe: TypeSafeConfig | undefined;
  interpretRateLimitRequests: number;
  interpretRateLimitWindowMs: number;
}

function positiveInteger(name: string, value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function allowedOrigins(value: string | undefined): string[] {
  const configured = (value ?? "http://localhost:5180").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (configured.length === 0) throw new Error("ALLOWED_ORIGINS must contain at least one origin");
  return configured.map((origin) => {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported allowed origin protocol: ${url.protocol}`);
    return url.origin;
  });
}

function geminiModel(value: string | undefined): string {
  const model = value?.trim() || GEMINI_LIVE_MODELS[0];
  if (!GEMINI_LIVE_MODELS.includes(model as typeof GEMINI_LIVE_MODELS[number])) {
    throw new Error(`GEMINI_LIVE_MODEL must be one of ${GEMINI_LIVE_MODELS.join(", ")}`);
  }
  return model;
}

function typeSafe(env: Record<string, string | undefined>): TypeSafeConfig | undefined {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;
  return { apiKey, model: env.TYPESAFE_MODEL?.trim() || "jev-1.13.0" };
}

function keyedProviders(env: Record<string, string | undefined>): Map<ProtocolId, LiveProviderConfig> {
  if (env.GEMINI_LIVE_BACKEND_MODEL?.trim()) {
    throw new Error("GEMINI_LIVE_BACKEND_MODEL is not supported because Gemini Live has no delegation protocol");
  }
  const maxOutputTokens = positiveInteger("MAX_OUTPUT_TOKENS", env.MAX_OUTPUT_TOKENS, 768, 4_096);
  if (maxOutputTokens < 16) throw new Error("MAX_OUTPUT_TOKENS must be at least 16");
  const keyed = new Map<ProtocolId, LiveProviderConfig>();
  const openAIKey = env.OPENAI_API_KEY?.trim();
  if (openAIKey) {
    keyed.set("openai-live", {
      protocol: "openai-live",
      apiKey: openAIKey,
      model: env.OPENAI_LIVE_MODEL?.trim() || "gpt-live-1",
      backendModel: env.OPENAI_LIVE_BACKEND_MODEL?.trim() || "gpt-5.6-luna",
      maxOutputTokens,
    });
  }
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey) keyed.set("gemini-live", { protocol: "gemini-live", apiKey: geminiKey, model: geminiModel(env.GEMINI_LIVE_MODEL) });
  return keyed;
}

function orderedProviders(requested: string, keyed: Map<ProtocolId, LiveProviderConfig>): LiveProviderConfig[] {
  const seen = new Set<ProtocolId>();
  return requested.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (!LIVE_PROTOCOLS.includes(entry as ProtocolId)) throw new Error(`LIVE_PROVIDERS names an unknown live protocol: ${entry}`);
    const protocol = entry as ProtocolId;
    if (seen.has(protocol)) throw new Error(`LIVE_PROVIDERS lists ${protocol} more than once`);
    seen.add(protocol);
    const provider = keyed.get(protocol);
    if (!provider) throw new Error(`LIVE_PROVIDERS names ${protocol} but its API key is not configured`);
    return provider;
  });
}

function liveProviders(env: Record<string, string | undefined>): [LiveProviderConfig, ...LiveProviderConfig[]] {
  const keyed = keyedProviders(env);
  const requested = env.LIVE_PROVIDERS?.trim();
  const ordered = requested ? orderedProviders(requested, keyed) : [...keyed.values()];
  const [first, ...rest] = ordered;
  if (!first) throw new Error("At least one live provider key is required: set OPENAI_API_KEY or GEMINI_API_KEY");
  return [first, ...rest];
}

export function readConfig(env: Record<string, string | undefined> = Bun.env): ServerConfig {
  return {
    providers: liveProviders(env),
    allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS),
    port: positiveInteger("PORT", env.PORT, 3010, 65_535),
    rateLimitRequests: positiveInteger("RATE_LIMIT_REQUESTS", env.RATE_LIMIT_REQUESTS, 8),
    rateLimitWindowMs: positiveInteger("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, 60_000),
    sessionBudgetRequests: positiveInteger("SESSION_BUDGET_REQUESTS", env.SESSION_BUDGET_REQUESTS, 30),
    sessionBudgetWindowMs: positiveInteger("SESSION_BUDGET_WINDOW_MS", env.SESSION_BUDGET_WINDOW_MS, 3_600_000),
    lifetimeStreamsPerOrigin: positiveInteger("LIFETIME_STREAMS_PER_ORIGIN", env.LIFETIME_STREAMS_PER_ORIGIN, 4),
    typesafe: typeSafe(env),
    interpretRateLimitRequests: positiveInteger("INTERPRET_RATE_LIMIT_REQUESTS", env.INTERPRET_RATE_LIMIT_REQUESTS, 120),
    interpretRateLimitWindowMs: positiveInteger("INTERPRET_RATE_LIMIT_WINDOW_MS", env.INTERPRET_RATE_LIMIT_WINDOW_MS, 60_000),
  };
}
