import type { ServerConfig } from "../config.js";
import { OriginGuard } from "../guards/origin.js";
import { SlidingWindowLimiter } from "../guards/rate-limit.js";
import type { FetchLike } from "../providers/openai-session.js";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY_BYTES = 32_768;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 64;
const UPSTREAM_TIMEOUT_MS = 5_000;
const QUESTION_TYPES = new Set(["choice", "noul", "score"]);
/** choice and score answer against a criteria set; noul answers a single yes-or-no instruction. */
const CRITERIA_TYPES = new Set(["choice", "score"]);

export interface InterpretRouteDependencies {
  config: ServerConfig;
  fetcher?: FetchLike;
  originGuard?: OriginGuard;
  rateLimiter?: SlidingWindowLimiter;
}

export function createInterpretRoute(dependencies: InterpretRouteDependencies) {
  const { config } = dependencies;
  const fetcher = dependencies.fetcher ?? fetch;
  const originGuard = dependencies.originGuard ?? new OriginGuard(config.allowedOrigins);
  const rateLimiter = dependencies.rateLimiter ?? new SlidingWindowLimiter(config.interpretRateLimitRequests, config.interpretRateLimitWindowMs);

  return async function interpretRoute(request: Request): Promise<Response> {
    const origin = request.headers.get("Origin");
    const admitted = originGuard.admit(origin);
    if (request.method === "OPTIONS") {
      if (!origin) return json({ error: "Origin is not allowed" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(admitted?.origin ?? origin) });
    }
    if (!admitted) return json({ error: "Origin is not allowed" }, 403, origin ? corsHeaders(origin) : {});
    const cors = corsHeaders(admitted.origin);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST, OPTIONS", ...cors });
    if (!rateLimiter.take(admitted.bucket)) {
      return json({ error: "Interpretation rate limit exceeded" }, 429, { "Retry-After": retryAfter(config.interpretRateLimitWindowMs), ...cors });
    }
    // The origin and the rate window come first so that an unconfigured server still refuses strangers.
    const typesafe = config.typesafe;
    if (!typesafe) return json({ error: "Interpretation is not configured" }, 503, cors);

    const body = await readBody(request);
    if (!body.ok) return json({ error: body.error }, body.status, cors);
    const interpretRequest = parseInterpretRequest(body.text);
    if ("error" in interpretRequest) return json({ error: interpretRequest.error }, 400, cors);

    let upstream: Response;
    try {
      upstream = await fetcher(SYSTEM_ONE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${typesafe.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        body: JSON.stringify({ state: interpretRequest.state, model: typesafe.model, questions: interpretRequest.questions }),
      });
    } catch (error) {
      console.error("Interpretation request failed", error instanceof Error ? error.message : String(error));
      return json({ error: "Interpretation failed" }, 502, cors);
    }
    if (upstream.status === 429 || upstream.status === 529) {
      return json({ error: "Interpretation rate limit exceeded" }, 429, { "Retry-After": upstream.headers.get("Retry-After") ?? "1", ...cors });
    }
    if (upstream.status !== 200) {
      console.error(`Interpretation upstream failed with status ${upstream.status}`);
      return json({ error: "Interpretation failed" }, 502, cors);
    }
    let answers: unknown;
    try {
      answers = await upstream.json();
    } catch {
      console.error("Interpretation upstream returned a body that is not JSON");
      return json({ error: "Interpretation failed" }, 502, cors);
    }
    return json(answers, 200, cors);
  };
}

interface InterpretRequest {
  state: unknown;
  questions: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInterpretRequest(text: string): InterpretRequest | { error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { error: "Body must be JSON" };
  }
  if (!isPlainObject(payload)) return { error: "Body must be an object with state and questions" };
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes("state") || !keys.includes("questions")) {
    return { error: "Body must have exactly the keys state and questions" };
  }
  const { state, questions } = payload;
  if (typeof state !== "string" && (typeof state !== "object" || state === null)) {
    return { error: "state must be a string, object, or array" };
  }
  if (!isPlainObject(questions)) return { error: "questions must be an object" };
  const ids = Object.keys(questions);
  if (ids.length < MIN_QUESTIONS || ids.length > MAX_QUESTIONS) {
    return { error: `questions must hold ${MIN_QUESTIONS} to ${MAX_QUESTIONS} entries` };
  }
  for (const id of ids) {
    const question = questions[id];
    if (!isPlainObject(question)) return { error: "Every question must be an object" };
    if (typeof question.type !== "string" || !QUESTION_TYPES.has(question.type)) {
      return { error: "Every question type must be choice, noul, or score" };
    }
    if (!("instructions" in question)) return { error: "Every question must have instructions" };
    if (CRITERIA_TYPES.has(question.type) && !("criteria" in question)) {
      return { error: "Every choice and score question must have criteria" };
    }
  }
  return { state, questions };
}

type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413; error: string };

async function readBody(request: Request): Promise<BodyRead> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "A JSON body is required" };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, error: "Interpretation request exceeds 32 KiB" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, status: 400, error: "A JSON body is required" };
  }
  return { ok: true, text: await new Blob(chunks).text() };
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
