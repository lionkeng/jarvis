import { describe, expect, test } from "bun:test";
import { createSessionRoute } from "./session.js";
import type { ServerConfig } from "../config.js";

const config: ServerConfig = {
  apiKey: "test-key", model: "gpt-live-1", allowedOrigins: ["https://voice.example"], port: 3010,
  rateLimitRequests: 1, rateLimitWindowMs: 60_000, sessionBudgetRequests: 10, sessionBudgetWindowMs: 3_600_000,
  maxOutputTokens: 512, backendModel: "gpt-5.6-luna", lifetimeStreamsPerOrigin: 4,
};
const lifetimeRequest = (init: RequestInit = {}) => new Request("http://localhost/session", { method: "GET", headers: { Origin: "https://voice.example" }, ...init });
const answer = { session: { id: "live_test" }, transport: { type: "webrtc", sdp: "v=0" } };
const fetcher = async () => Response.json(answer);

describe("session route", () => {
  test("streams a ready event for an allowed origin and cleans up when the reader cancels", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Array<number | undefined> = [];
    const cleared: Array<ReturnType<typeof setInterval> | undefined> = [];
    const timer = 41 as unknown as ReturnType<typeof setInterval>;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervals.push(args[1]);
      return timer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
      cleared.push(handle);
    }) as typeof clearInterval;
    try {
      const route = createSessionRoute({ config, fetcher });
      const response = await route(new Request("http://localhost/session", { method: "GET", headers: { Origin: "https://voice.example" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("event: ready\ndata: {}\n\n");
      expect(intervals).toEqual([5_000]);
      await reader.cancel();
      expect(cleared).toEqual([timer]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("rejects a lifetime stream without an Origin and an untrusted origin without CORS", async () => {
    const route = createSessionRoute({ config, fetcher });
    const missing = await route(new Request("http://localhost/session", { method: "GET" }));
    expect(missing.status).toBe(403);
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
    expect(await missing.json()).toEqual({ error: "Origin is not allowed" });

    const rejected = await route(new Request("http://localhost/session", { method: "GET", headers: { Origin: "https://attacker.example" } }));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    expect(await rejected.json()).toEqual({ error: "Origin is not allowed" });
  });

  test("streams a lifetime lease for other loopback origins when localhost is configured", async () => {
    const route = createSessionRoute({ config: { ...config, allowedOrigins: ["http://localhost:5180"] }, fetcher });
    const response = await route(new Request("http://localhost/session", { method: "GET", headers: { Origin: "http://127.0.0.1:4321" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4321");
    await response.body!.cancel();
  });

  test("cleans up a lifetime stream when its request aborts", async () => {
    const originalClearInterval = globalThis.clearInterval;
    const cleared: Array<ReturnType<typeof setInterval> | undefined> = [];
    globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
      originalClearInterval(handle);
      cleared.push(handle);
    }) as typeof clearInterval;
    try {
      const abort = new AbortController();
      const route = createSessionRoute({ config, fetcher });
      const response = await route(new Request("http://localhost/session", { method: "GET", headers: { Origin: "https://voice.example" }, signal: abort.signal }));
      abort.abort();
      expect(cleared).toHaveLength(1);
      await response.body!.cancel();
      expect(cleared).toHaveLength(1);
    } finally {
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("caps concurrent lifetime streams per origin", async () => {
    const route = createSessionRoute({ config: { ...config, lifetimeStreamsPerOrigin: 2 }, fetcher });
    const streams = [await route(lifetimeRequest()), await route(lifetimeRequest())];
    for (const stream of streams) expect(stream.status).toBe(200);
    const limited = await route(lifetimeRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect(limited.headers.get("retry-after")).toBeNull();
    expect(await limited.json()).toEqual({ error: "Origin lifetime stream limit exceeded" });
    for (const stream of streams) await stream.body!.cancel();
  });

  test("frees a lifetime slot when a stream closes", async () => {
    const route = createSessionRoute({ config: { ...config, lifetimeStreamsPerOrigin: 1 }, fetcher });
    const first = await route(lifetimeRequest());
    expect(first.status).toBe(200);
    expect((await route(lifetimeRequest())).status).toBe(429);
    await first.body!.cancel();
    const reopened = await route(lifetimeRequest());
    expect(reopened.status).toBe(200);
    await reopened.body!.cancel();
  });

  test("counts a lifetime stream once when abort and cancel both clean up", async () => {
    const route = createSessionRoute({ config: { ...config, lifetimeStreamsPerOrigin: 1 }, fetcher });
    const abort = new AbortController();
    const first = await route(lifetimeRequest({ signal: abort.signal }));
    expect(first.status).toBe(200);
    abort.abort();
    await first.body!.cancel();
    const second = await route(lifetimeRequest());
    expect(second.status).toBe(200);
    expect((await route(lifetimeRequest())).status).toBe(429);
    await second.body!.cancel();
  });

  test("does not charge lifetime streams against the POST rate window or budget", async () => {
    const route = createSessionRoute({ config, fetcher });
    const first = await route(new Request("http://localhost/session", { method: "GET", headers: { Origin: "https://voice.example" } }));
    const second = await route(new Request("http://localhost/session", { method: "GET", headers: { Origin: "https://voice.example" } }));
    await first.body!.cancel();
    await second.body!.cancel();
    const response = await route(new Request("http://localhost/session", { method: "POST", body: JSON.stringify({ sdp: "v=0" }), headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(201);
  });

  test("returns a no-store SDP answer for an allowed origin", async () => {
    const route = createSessionRoute({ config, fetcher });
    const response = await route(new Request("http://localhost/session", { method: "POST", body: JSON.stringify({ sdp: "v=0" }), headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://voice.example");
    expect(await response.json()).toEqual(answer);
  });

  test("creates sessions for other loopback origins when localhost is configured", async () => {
    const route = createSessionRoute({
      config: { ...config, allowedOrigins: ["http://localhost:5180"] },
      fetcher,
    });
    const response = await route(new Request("http://localhost/session", { method: "POST", body: JSON.stringify({ sdp: "v=0" }), headers: { Origin: "http://[::1]:5180" } }));
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://[::1]:5180");
  });

  test("forwards validated live-session preferences to OpenAI", async () => {
    let providerBody: Record<string, unknown> | undefined;
    const route = createSessionRoute({
      config,
      fetcher: async (_input, init) => {
        providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(answer);
      },
    });
    const response = await route(new Request("http://localhost/session", {
      method: "POST",
      headers: { Origin: "https://voice.example", "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: "v=0", responseTiming: "patient", speechRate: 0.9, model: "untrusted", backendModel: "untrusted" }),
    }));

    expect(response.status).toBe(201);
    expect(providerBody).toMatchObject({
      transport: { type: "webrtc", sdp: "v=0" },
      session: { model: "gpt-live-1", instructions: expect.stringContaining("0.9 times normal"), delegation: { responses: { model: "gpt-5.6-luna" } } },
    });
  });

  test("rejects missing, blank and oversized offers before calling the provider", async () => {
    for (const body of [{}, { sdp: " " }, { sdp: 1 }, { sdp: "x".repeat(65_536) }]) {
      let called = false;
      const route = createSessionRoute({ config, fetcher: async () => { called = true; return Response.json(answer); } });
      const response = await route(new Request("http://localhost/session", { method: "POST", headers: { Origin: "https://voice.example" }, body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    }
  });

  test("rejects malformed or out-of-policy session preferences", async () => {
    let called = false;
    const route = createSessionRoute({ config, fetcher: async () => { called = true; return Response.json({ value: "bad" }); } });
    const response = await route(new Request("http://localhost/session", {
      method: "POST",
      headers: { Origin: "https://voice.example", "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: "v=0", responseTiming: "instant", speechRate: 2 }),
    }));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects untrusted origins before calling OpenAI", async () => {
    let called = false;
    const route = createSessionRoute({ config, fetcher: async () => { called = true; return Response.json({ value: "bad" }); } });
    const response = await route(new Request("http://localhost/session", { method: "POST", body: JSON.stringify({ sdp: "v=0" }), headers: { Origin: "https://attacker.example" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://attacker.example");
    expect(await response.json()).toEqual({ error: "Origin is not allowed" });
    expect(called).toBe(false);
  });

  test("answers OPTIONS preflight for a disallowed origin so the browser can read the POST error", async () => {
    const route = createSessionRoute({ config, fetcher });
    const response = await route(new Request("http://localhost/session", { method: "OPTIONS", headers: { Origin: "https://attacker.example" } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://attacker.example");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  test("rate limits per origin and ignores spoofable forwarded-address headers", async () => {
    const route = createSessionRoute({ config, fetcher });
    const request = (forwardedFor: string) => new Request("http://localhost/session", { method: "POST", body: JSON.stringify({ sdp: "v=0" }), headers: { Origin: "https://voice.example", "x-forwarded-for": forwardedFor } });
    expect((await route(request("127.0.0.1"))).status).toBe(201);
    const limited = await route(request("203.0.113.45"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  test("rejects malformed methods", async () => {
    const route = createSessionRoute({ config, fetcher });
    const response = await route(new Request("http://localhost/session", { method: "PUT", headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, OPTIONS");
  });

  test("returns a generic gateway error when the provider fails", async () => {
    const route = createSessionRoute({ config, fetcher: async () => new Response("provider secret", { status: 500 }) });
    const response = await route(new Request("http://localhost/session", { method: "POST", body: JSON.stringify({ sdp: "v=0" }), headers: { Origin: "https://voice.example" } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("provider secret");
  });
});
