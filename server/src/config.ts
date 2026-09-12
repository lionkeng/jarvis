export interface ServerConfig {
  apiKey: string;
  model: string;
  allowedOrigins: string[];
  port: number;
  rateLimitRequests: number;
  rateLimitWindowMs: number;
  sessionBudgetRequests: number;
  sessionBudgetWindowMs: number;
  maxOutputTokens: number;
  backendModel: string;
  lifetimeStreamsPerOrigin: number;
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

export function readConfig(env: Record<string, string | undefined> = Bun.env): ServerConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const maxOutputTokens = positiveInteger("MAX_OUTPUT_TOKENS", env.MAX_OUTPUT_TOKENS, 768, 4_096);
  if (maxOutputTokens < 16) throw new Error("MAX_OUTPUT_TOKENS must be at least 16");
  return {
    apiKey,
    model: env.OPENAI_LIVE_MODEL?.trim() || "gpt-live-1",
    allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS),
    port: positiveInteger("PORT", env.PORT, 3010, 65_535),
    rateLimitRequests: positiveInteger("RATE_LIMIT_REQUESTS", env.RATE_LIMIT_REQUESTS, 8),
    rateLimitWindowMs: positiveInteger("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, 60_000),
    sessionBudgetRequests: positiveInteger("SESSION_BUDGET_REQUESTS", env.SESSION_BUDGET_REQUESTS, 30),
    sessionBudgetWindowMs: positiveInteger("SESSION_BUDGET_WINDOW_MS", env.SESSION_BUDGET_WINDOW_MS, 3_600_000),
    maxOutputTokens,
    backendModel: env.OPENAI_LIVE_BACKEND_MODEL?.trim() || "gpt-5.6-luna",
    lifetimeStreamsPerOrigin: positiveInteger("LIFETIME_STREAMS_PER_ORIGIN", env.LIFETIME_STREAMS_PER_ORIGIN, 4),
  };
}
