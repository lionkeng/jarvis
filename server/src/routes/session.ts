import type { ServerConfig } from "../config.js";
import { SessionBudget } from "../guards/budget.js";
import { OriginGuard } from "../guards/origin.js";
import { SlidingWindowLimiter } from "../guards/rate-limit.js";
import { createOpenAIClientSecret, type FetchLike } from "../providers/openai-session.js";
import { parseSessionPreferences, type SessionPreferences } from "../session-preferences.js";

export interface SessionRouteDependencies {
  config: ServerConfig;
  fetcher?: FetchLike;
  originGuard?: OriginGuard;
  rateLimiter?: SlidingWindowLimiter;
  sessionBudget?: SessionBudget;
}

export function createSessionRoute(dependencies: SessionRouteDependencies) {
  const { config } = dependencies;
  const originGuard = dependencies.originGuard ?? new OriginGuard(config.allowedOrigins);
  const rateLimiter = dependencies.rateLimiter ?? new SlidingWindowLimiter(config.rateLimitRequests, config.rateLimitWindowMs);
  const sessionBudget = dependencies.sessionBudget ?? new SessionBudget(config.sessionBudgetRequests, config.sessionBudgetWindowMs);

  return async function sessionRoute(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      return originGuard.allows(origin)
        ? new Response(null, { status: 204, headers: corsHeaders(origin!) })
        : json({ error: "Origin is not allowed" }, 403);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST, OPTIONS" });
    const origin = request.headers.get("Origin");
    if (!originGuard.allows(origin)) return json({ error: "Origin is not allowed" }, 403);
    if (!rateLimiter.take(origin!)) return json({ error: "Session request rate limit exceeded" }, 429, { "Retry-After": retryAfter(config.rateLimitWindowMs), ...corsHeaders(origin!) });
    let preferences: SessionPreferences;
    try {
      preferences = parseSessionPreferences(await requestBody(request));
    } catch {
      return json({ error: "Invalid session preferences" }, 400, corsHeaders(origin!));
    }
    if (!sessionBudget.reserve(origin!)) return json({ error: "Origin session budget exhausted" }, 429, { "Retry-After": retryAfter(config.sessionBudgetWindowMs), ...corsHeaders(origin!) });
    try {
      const secret = await createOpenAIClientSecret(config.apiKey, {
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        contextTokenLimit: config.contextTokenLimit,
        preferences,
      }, dependencies.fetcher);
      return json(secret, 200, { "Cache-Control": "no-store", ...corsHeaders(origin!) });
    } catch (error) {
      console.error("Session issuance failed", error instanceof Error ? error.message : String(error));
      return json({ error: "Unable to create a realtime session" }, 502, corsHeaders(origin!));
    }
  };
}

async function requestBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (!body.trim()) return undefined;
  return JSON.parse(body) as unknown;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function retryAfter(windowMs: number): string {
  return String(Math.max(1, Math.ceil(windowMs / 1_000)));
}
