import { describe, expect, test } from "bun:test";
import { createSessionRoute } from "./session.js";
import type { ServerConfig } from "../config.js";

const config: ServerConfig = {
  apiKey: "test-key", model: "gpt-realtime-2.1-mini", allowedOrigins: ["https://voice.example"], port: 3001,
  rateLimitRequests: 1, rateLimitWindowMs: 60_000, sessionBudgetRequests: 10, sessionBudgetWindowMs: 3_600_000,
  maxOutputTokens: 512, contextTokenLimit: 4000,
};
const fetcher = async () => Response.json({ value: "ek_test", expires_at: Math.floor(Date.now() / 1000) + 60 });

describe("session route", () => {
  test("mints a no-store token for an allowed origin", async () => {
    const route = createSessionRoute({ config, fetcher });
    const response = await route(new Request("http://localhost/session", { method: "POST", headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect((await response.json() as { value: string }).value).toBe("ek_test");
  });

  test("forwards validated live-session preferences to OpenAI", async () => {
    let providerBody: Record<string, unknown> | undefined;
    const route = createSessionRoute({
      config,
      fetcher: async (_input, init) => {
        providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ value: "ek_preferences", expires_at: Math.floor(Date.now() / 1000) + 60 });
      },
    });
    const response = await route(new Request("http://localhost/session", {
      method: "POST",
      headers: { Origin: "https://voice.example", "Content-Type": "application/json" },
      body: JSON.stringify({ responseTiming: "patient", speechRate: 0.9 }),
    }));

    expect(response.status).toBe(200);
    expect(providerBody).toMatchObject({
      session: {
        reasoning: { effort: "medium" },
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper",
              language: "zh",
              delay: "high",
            },
            turn_detection: { eagerness: "low" },
          },
          output: { speed: 0.9 },
        },
      },
    });
  });

  test("rejects malformed or out-of-policy session preferences", async () => {
    let called = false;
    const route = createSessionRoute({ config, fetcher: async () => { called = true; return Response.json({ value: "bad" }); } });
    const response = await route(new Request("http://localhost/session", {
      method: "POST",
      headers: { Origin: "https://voice.example", "Content-Type": "application/json" },
      body: JSON.stringify({ responseTiming: "instant", speechRate: 2 }),
    }));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects untrusted origins before calling OpenAI", async () => {
    let called = false;
    const route = createSessionRoute({ config, fetcher: async () => { called = true; return Response.json({ value: "bad" }); } });
    const response = await route(new Request("http://localhost/session", { method: "POST", headers: { Origin: "https://attacker.example" } }));
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  test("rate limits per origin and ignores spoofable forwarded-address headers", async () => {
    const route = createSessionRoute({ config, fetcher });
    const request = (forwardedFor: string) => new Request("http://localhost/session", { method: "POST", headers: { Origin: "https://voice.example", "x-forwarded-for": forwardedFor } });
    expect((await route(request("127.0.0.1"))).status).toBe(200);
    const limited = await route(request("203.0.113.45"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  test("rejects malformed methods", async () => {
    const route = createSessionRoute({ config, fetcher });
    const response = await route(new Request("http://localhost/session", { method: "PUT", headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  test("returns a generic gateway error when the provider fails", async () => {
    const route = createSessionRoute({ config, fetcher: async () => new Response("provider secret", { status: 500 }) });
    const response = await route(new Request("http://localhost/session", { method: "POST", headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("provider secret");
  });
});
