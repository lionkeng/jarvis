import type { ServerConfig } from "../config.js";
import { SessionBudget } from "../guards/budget.js";
import { OriginGuard } from "../guards/origin.js";
import { SlidingWindowLimiter } from "../guards/rate-limit.js";
import { createOpenAILiveSession, type FetchLike } from "../providers/openai-session.js";
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
  const openLifetimeStreams = new Map<string, number>();

  const releaseLifetimeStream = (origin: string) => {
    const open = openLifetimeStreams.get(origin) ?? 0;
    if (open <= 1) openLifetimeStreams.delete(origin);
    else openLifetimeStreams.set(origin, open - 1);
  };

  return async function sessionRoute(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (!origin) return json({ error: "Origin is not allowed" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const origin = request.headers.get("Origin");
    if (request.method === "GET") {
      if (!originGuard.allows(origin)) return json({ error: "Origin is not allowed" }, 403);
      const open = openLifetimeStreams.get(origin!) ?? 0;
      if (open >= config.lifetimeStreamsPerOrigin) return json({ error: "Origin lifetime stream limit exceeded" }, 429, corsHeaders(origin!));
      openLifetimeStreams.set(origin!, open + 1);
      return lifetimeStream(request, corsHeaders(origin!), () => releaseLifetimeStream(origin!));
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
    if (!originGuard.allows(origin)) return json({ error: "Origin is not allowed" }, 403, origin ? corsHeaders(origin) : {});
    if (!rateLimiter.take(origin!)) return json({ error: "Session request rate limit exceeded" }, 429, { "Retry-After": retryAfter(config.rateLimitWindowMs), ...corsHeaders(origin!) });
    let preferences: SessionPreferences;
    let sdp: string;
    try {
      const body = await requestBody(request);
      if (!body || typeof body !== "object" || !("sdp" in body) || typeof body.sdp !== "string" || !body.sdp.trim()) throw new Error("An SDP offer is required");
      sdp = body.sdp;
      preferences = parseSessionPreferences(body);
    } catch {
      return json({ error: "Invalid SDP offer or session preferences" }, 400, corsHeaders(origin!));
    }
    if (!sessionBudget.reserve(origin!)) return json({ error: "Origin session budget exhausted" }, 429, { "Retry-After": retryAfter(config.sessionBudgetWindowMs), ...corsHeaders(origin!) });
    try {
      const session = await createOpenAILiveSession(config.apiKey, sdp, {
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        backendModel: config.backendModel,
        preferences,
      }, dependencies.fetcher);
      return json(session, 201, { "Cache-Control": "no-store", ...corsHeaders(origin!) });
    } catch (error) {
      console.error("Session issuance failed", error instanceof Error ? error.message : String(error));
      return json({ error: "Unable to create a Live session" }, 502, corsHeaders(origin!));
    }
  };
}

function lifetimeStream(request: Request, cors: Record<string, string>, release: () => void): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    request.signal.removeEventListener("abort", cleanup);
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          cleanup();
        }
      }, 5_000);
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) cleanup();
    },
    cancel: cleanup,
  });
  return new Response(body, { headers: {
    "Cache-Control": "no-store",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
    ...cors,
  } });
}

async function requestBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("An SDP offer is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 65_536) {
      await reader.cancel();
      throw new Error("Session request exceeds 64 KiB");
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(await new Blob(chunks).text()) as unknown;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
