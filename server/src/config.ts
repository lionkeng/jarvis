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
  contextTokenLimit: number;
  realtimeTracing: boolean;
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

function realtimeTracing(value: string | undefined): boolean {
  const parsed = value?.trim() ?? "";
  if (parsed === "") return true;
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new Error("OPENAI_REALTIME_TRACING must be true or false");
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
  return {
    apiKey,
    model: env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
    allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS),
    port: positiveInteger("PORT", env.PORT, 3010, 65_535),
    rateLimitRequests: positiveInteger("RATE_LIMIT_REQUESTS", env.RATE_LIMIT_REQUESTS, 8),
    rateLimitWindowMs: positiveInteger("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, 60_000),
    sessionBudgetRequests: positiveInteger("SESSION_BUDGET_REQUESTS", env.SESSION_BUDGET_REQUESTS, 30),
    sessionBudgetWindowMs: positiveInteger("SESSION_BUDGET_WINDOW_MS", env.SESSION_BUDGET_WINDOW_MS, 3_600_000),
    maxOutputTokens: positiveInteger("MAX_OUTPUT_TOKENS", env.MAX_OUTPUT_TOKENS, 768, 4_096),
    contextTokenLimit: positiveInteger("CONTEXT_TOKEN_LIMIT", env.CONTEXT_TOKEN_LIMIT, 8_000),
    realtimeTracing: realtimeTracing(env.OPENAI_REALTIME_TRACING),
  };
}
