import { expect, test } from "bun:test";
import type { ServerConfig } from "./config.js";
import { createServer } from "./index.js";

test("built server shape responds across a real Bun HTTP listener", async () => {
  const baseConfig: ServerConfig = {
    apiKey: "test-only", model: "gpt-realtime-2.1-mini", allowedOrigins: ["http://localhost:5180"], port: 30_000,
    rateLimitRequests: 2, rateLimitWindowMs: 1000, sessionBudgetRequests: 2, sessionBudgetWindowMs: 1000,
    maxOutputTokens: 128, contextTokenLimit: 1000, realtimeTracing: true,
  };
  let server: ReturnType<typeof createServer> | undefined;
  for (let attempt = 0; attempt < 10 && !server; attempt += 1) {
    const randomValue = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
    const port = 20_000 + randomValue % 40_000;
    try {
      server = createServer({ ...baseConfig, port });
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  if (!server) throw new Error("Could not reserve a loopback port for the Bun server test");
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, runtime: "bun" });
    const rejected = await fetch(`${base}/session`, { method: "POST", headers: { Origin: "https://attacker.example" } });
    expect(rejected.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});
