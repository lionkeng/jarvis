import { expect, test } from "bun:test";
import type { ServerConfig } from "./config.js";
import { createServer } from "./index.js";

const baseConfig: ServerConfig = {
  apiKey: "test-only", model: "gpt-live-1", allowedOrigins: ["http://localhost:5180"], port: 30_000,
  rateLimitRequests: 2, rateLimitWindowMs: 1000, sessionBudgetRequests: 2, sessionBudgetWindowMs: 1000,
  maxOutputTokens: 128, backendModel: "gpt-5.6-luna", lifetimeStreamsPerOrigin: 4,
};

test("serves with an idle timeout longer than the lifetime heartbeat", () => {
  const originalServe = Bun.serve;
  let options: { idleTimeout?: number } | undefined;
  (Bun as { serve: typeof Bun.serve }).serve = ((received: { idleTimeout?: number }) => {
    options = received;
    return { port: 0, stop: async () => {} };
  }) as unknown as typeof Bun.serve;
  try {
    createServer(baseConfig);
  } finally {
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
  }
  expect(options?.idleTimeout).toBe(30);
});

test("built server shape responds across a real Bun HTTP listener", async () => {
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
