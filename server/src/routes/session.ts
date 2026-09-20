import type { LiveProviderConfig, ServerConfig } from "../config.js";
import { SessionBudget } from "../guards/budget.js";
import { OriginGuard } from "../guards/origin.js";
import { SlidingWindowLimiter } from "../guards/rate-limit.js";
import { createGeminiLiveGrant, type LiveTokenGrant } from "../providers/gemini-session.js";
import { createOpenAILiveSession, type FetchLike, type LiveSessionResponse } from "../providers/openai-session.js";
import { parseSessionRequest, type ProtocolId, type SessionRequest } from "../session-request.js";

export type LiveGrant = LiveSessionResponse | LiveTokenGrant;

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

  const releaseLifetimeStream = (bucket: string) => {
    const open = openLifetimeStreams.get(bucket) ?? 0;
    if (open <= 1) openLifetimeStreams.delete(bucket);
    else openLifetimeStreams.set(bucket, open - 1);
  };

  const providerFor = <P extends ProtocolId>(protocol: P): Extract<LiveProviderConfig, { protocol: P }> => {
    const provider = config.providers.find((candidate) => candidate.protocol === protocol);
    if (!provider) throw new Error(`No live provider is configured for ${protocol}`);
    return provider as Extract<LiveProviderConfig, { protocol: P }>;
  };

  const issueGrant = (sessionRequest: SessionRequest): () => Promise<LiveGrant> => {
    switch (sessionRequest.protocol) {
      case "openai-live": {
        const provider = providerFor("openai-live");
        const { sdp, preferences } = sessionRequest;
        return () => createOpenAILiveSession(provider.apiKey, sdp, {
          model: provider.model,
          maxOutputTokens: provider.maxOutputTokens,
          backendModel: provider.backendModel,
          preferences,
        }, dependencies.fetcher);
      }
      case "gemini-live": {
        const provider = providerFor("gemini-live");
        const { preferences } = sessionRequest;
        return () => createGeminiLiveGrant(provider.apiKey, { model: provider.model, preferences }, dependencies.fetcher);
      }
    }
  };

  return async function sessionRoute(request: Request): Promise<Response> {
    const origin = request.headers.get("Origin");
    const admitted = originGuard.admit(origin);
    if (request.method === "OPTIONS") {
      if (!origin) return json({ error: "Origin is not allowed" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(admitted?.origin ?? origin) });
    }
    if (request.method === "GET") {
      if (!admitted) return json({ error: "Origin is not allowed" }, 403);
      const cors = corsHeaders(admitted.origin);
      const open = openLifetimeStreams.get(admitted.bucket) ?? 0;
      if (open >= config.lifetimeStreamsPerOrigin) return json({ error: "Origin lifetime stream limit exceeded" }, 429, cors);
      openLifetimeStreams.set(admitted.bucket, open + 1);
      return lifetimeStream(request, cors, config.providers.map((provider) => provider.protocol), () => releaseLifetimeStream(admitted.bucket));
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
    if (!admitted) return json({ error: "Origin is not allowed" }, 403, origin ? corsHeaders(origin) : {});
    const cors = corsHeaders(admitted.origin);
    if (!rateLimiter.take(admitted.bucket)) return json({ error: "Session request rate limit exceeded" }, 429, { "Retry-After": retryAfter(config.rateLimitWindowMs), ...cors });
    let grant: () => Promise<LiveGrant>;
    try {
      grant = issueGrant(parseSessionRequest(await requestBody(request)));
    } catch {
      return json({ error: "Invalid SDP offer or session preferences" }, 400, cors);
    }
    if (!sessionBudget.reserve(admitted.bucket)) return json({ error: "Origin session budget exhausted" }, 429, { "Retry-After": retryAfter(config.sessionBudgetWindowMs), ...cors });
    try {
      return json(await grant(), 201, { "Cache-Control": "no-store", ...cors });
    } catch (error) {
      console.error("Session issuance failed", error instanceof Error ? error.message : String(error));
      return json({ error: "Unable to create a Live session" }, 502, cors);
    }
  };
}

function lifetimeStream(request: Request, cors: Record<string, string>, protocols: ProtocolId[], release: () => void): Response {
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
      controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ protocols })}\n\n`));
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
