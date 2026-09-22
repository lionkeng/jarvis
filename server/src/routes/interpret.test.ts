import { describe, expect, test } from "bun:test";
import { createInterpretRoute } from "./interpret.js";
import type { LiveProviderConfig, ServerConfig } from "../config.js";

const openAIProvider: LiveProviderConfig = { protocol: "openai-live", apiKey: "test-key", model: "gpt-live-1", backendModel: "gpt-5.6-luna", maxOutputTokens: 512 };
const unconfigured: ServerConfig = {
  providers: [openAIProvider], allowedOrigins: ["https://voice.example"], port: 3010,
  rateLimitRequests: 8, rateLimitWindowMs: 60_000, sessionBudgetRequests: 10, sessionBudgetWindowMs: 3_600_000,
  lifetimeStreamsPerOrigin: 4, typesafe: undefined,
  interpretRateLimitRequests: 120, interpretRateLimitWindowMs: 60_000,
};
const config: ServerConfig = { ...unconfigured, typesafe: { apiKey: "ts-secret", model: "jev-1.13.0" } };

const upstreamAnswer = {
  model: "jev-1.13.0",
  answers: { operates: { probability: 0.97 }, control: { choice: "article.content", confidence: 0.91 } },
  usage: { input_tokens: 812 },
};

const questions = {
  operates: { type: "noul", instructions: "Does `request` operate something on the screen?" },
  control: { type: "choice", instructions: "Which control?", criteria: { "article.content": "Scroll the article text", none: "No control" } },
};
const state = { request: "scroll the article to the bottom", screen: { surface: "Jarvis voice demo", page: "article" } };

const post = (body: unknown, origin = "https://voice.example") => new Request("http://localhost/interpret", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const okFetcher = async () => Response.json(upstreamAnswer);
const failIfCalled = () => {
  let called = false;
  return {
    get called() { return called; },
    fetcher: async () => { called = true; return Response.json(upstreamAnswer); },
  };
};

describe("interpret route", () => {
  test("answers 503 when no TypeSafe key is configured", async () => {
    const spy = failIfCalled();
    const route = createInterpretRoute({ config: unconfigured, fetcher: spy.fetcher });
    const response = await route(post({ state, questions }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Interpretation is not configured" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect(spy.called).toBe(false);
  });

  test("refuses an untrusted origin before it reveals whether interpretation is configured", async () => {
    const spy = failIfCalled();
    const route = createInterpretRoute({ config: unconfigured, fetcher: spy.fetcher });
    const response = await route(post({ state, questions }, "https://attacker.example"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Origin is not allowed" });
    expect(spy.called).toBe(false);

    const missing = await route(new Request("http://localhost/interpret", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(403);
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("answers the OPTIONS preflight with CORS headers", async () => {
    const route = createInterpretRoute({ config, fetcher: okFetcher });
    const response = await route(new Request("http://localhost/interpret", { method: "OPTIONS", headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("allows only POST", async () => {
    const route = createInterpretRoute({ config, fetcher: okFetcher });
    const response = await route(new Request("http://localhost/interpret", { method: "GET", headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  test("applies its own rate window with a Retry-After", async () => {
    const route = createInterpretRoute({ config: { ...config, interpretRateLimitRequests: 2, interpretRateLimitWindowMs: 30_000 }, fetcher: okFetcher });
    expect((await route(post({ state, questions }))).status).toBe(200);
    expect((await route(post({ state, questions }))).status).toBe(200);
    const limited = await route(post({ state, questions }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(limited.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect(await limited.json()).toEqual({ error: "Interpretation rate limit exceeded" });
  });

  test("charges the rate window before it checks the key", async () => {
    const route = createInterpretRoute({ config: { ...unconfigured, interpretRateLimitRequests: 1 }, fetcher: okFetcher });
    expect((await route(post({ state, questions }))).status).toBe(503);
    expect((await route(post({ state, questions }))).status).toBe(429);
  });

  test("rejects a malformed body with 400", async () => {
    const spy = failIfCalled();
    const route = createInterpretRoute({ config: { ...config, interpretRateLimitRequests: 1_000 }, fetcher: spy.fetcher });
    const bodies: unknown[] = [
      "not json",
      [],
      { questions },
      { state },
      { state, questions, model: "jev-latest" },
      { state, questions, apiKey: "stolen" },
      { state: null, questions },
      { state, questions: [] },
      { state, questions: {} },
      { state, questions: { operates: "yes" } },
      { state, questions: { operates: { type: "sentiment", instructions: "..." } } },
      { state, questions: { operates: { type: "noul" } } },
      { state, questions: { control: { type: "choice", instructions: "..." } } },
      { state, questions: { amount: { type: "score", instructions: "..." } } },
      { state, questions: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, { type: "noul", instructions: "..." }])) },
    ];
    for (const body of bodies) {
      const response = await route(post(body));
      expect(response.status).toBe(400);
      expect(typeof (await response.json() as { error: unknown }).error).toBe("string");
    }
    expect(spy.called).toBe(false);
  });

  test("accepts the smallest and the largest allowed question map", async () => {
    const route = createInterpretRoute({ config: { ...config, interpretRateLimitRequests: 10 }, fetcher: okFetcher });
    const one = await route(post({ state: "scroll down", questions: { operates: { type: "noul", instructions: "..." } } }));
    expect(one.status).toBe(200);
    const sixtyFour = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`q${index}`, { type: "noul", instructions: "..." }]));
    expect((await route(post({ state: [1, 2], questions: sixtyFour }))).status).toBe(200);
  });

  test("rejects a body over 32 KiB with 413 before it parses", async () => {
    const spy = failIfCalled();
    const route = createInterpretRoute({ config, fetcher: spy.fetcher });
    const response = await route(post(JSON.stringify({ state: "x".repeat(40_000), questions })));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Interpretation request exceeds 32 KiB" });
    expect(spy.called).toBe(false);
  });

  test("forwards the pinned model and the server key and passes the upstream body through", async () => {
    let sent: { url: string; method: string | undefined; headers: Headers; body: Record<string, unknown> } | undefined;
    const route = createInterpretRoute({
      config,
      fetcher: async (url, init) => {
        sent = { url: String(url), method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
        return Response.json(upstreamAnswer);
      },
    });
    const response = await route(post({ state, questions }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect(await response.json()).toEqual(upstreamAnswer);

    expect(sent?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("Authorization")).toBe("Bearer ts-secret");
    expect(sent?.headers.get("Content-Type")).toBe("application/json");
    expect(Object.keys(sent?.body ?? {})).toEqual(["state", "model", "questions"]);
    expect(sent?.body.model).toBe("jev-1.13.0");
    expect(sent?.body.state).toEqual(state);
    expect(sent?.body.questions).toEqual(questions);
  });

  test("never lets the browser choose the model or the key", async () => {
    let sent: Record<string, unknown> | undefined;
    const route = createInterpretRoute({
      config,
      fetcher: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(upstreamAnswer);
      },
    });
    const rejected = await route(post({ state, questions, model: "jev-latest", apiKey: "browser-key" }));
    expect(rejected.status).toBe(400);
    expect(sent).toBeUndefined();

    const accepted = await route(post({ state, questions }));
    expect(accepted.status).toBe(200);
    expect(JSON.stringify(sent)).not.toContain("browser-key");
    expect(JSON.stringify(sent)).not.toContain("jev-latest");
  });

  test("passes an upstream 429 and 529 through as 429 with a Retry-After", async () => {
    for (const [status, header, expected] of [[429, "17", "17"], [429, null, "1"], [529, null, "1"]] as const) {
      const route = createInterpretRoute({
        config,
        fetcher: async () => new Response("{}", { status, headers: header ? { "Retry-After": header } : {} }),
      });
      const response = await route(post({ state, questions }));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe(expected);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    }
  });

  test("returns a generic 502 for any other upstream failure without leaking the body", async () => {
    const route = createInterpretRoute({ config, fetcher: async () => new Response("upstream secret", { status: 500 }) });
    const response = await route(post({ state, questions }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Interpretation failed" });
    expect(text).not.toContain("upstream secret");
  });

  test("returns 502 when the fetcher throws", async () => {
    const route = createInterpretRoute({ config, fetcher: async () => { throw new Error("The operation timed out."); } });
    const response = await route(post({ state, questions }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Interpretation failed" });
  });

  test("returns 502 when the upstream 200 is not JSON", async () => {
    const route = createInterpretRoute({ config, fetcher: async () => new Response("<html>gateway</html>", { status: 200 }) });
    const response = await route(post({ state, questions }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Interpretation failed" });
  });

  test("makes exactly one upstream attempt", async () => {
    let attempts = 0;
    const route = createInterpretRoute({
      config,
      fetcher: async () => { attempts += 1; return new Response("{}", { status: 500 }); },
    });
    expect((await route(post({ state, questions }))).status).toBe(502);
    expect(attempts).toBe(1);
  });
});
