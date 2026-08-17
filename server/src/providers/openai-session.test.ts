import { describe, expect, test } from "bun:test";
import { createOpenAIClientSecret } from "./openai-session.js";

describe("createOpenAIClientSecret", () => {
  test("calls the GA endpoint and applies server-owned caps", async () => {
    let request: RequestInit | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/realtime/client_secrets");
      request = init;
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 2_000 }), { status: 200 });
    });
    const result = await createOpenAIClientSecret("server-key", {
      model: "gpt-realtime-2.1-mini",
      maxOutputTokens: 512,
      contextTokenLimit: 4000,
      preferences: { responseTiming: "fast", speechRate: 1.15 },
    }, fetcher, () => 1_000_000);
    expect(result.value).toBe("ek_test");
    const body = JSON.parse(String(request?.body));
    expect(body.session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1-mini", max_output_tokens: 512 });
    expect(body.session.reasoning).toEqual({ effort: "minimal" });
    expect(body.session.audio.input.transcription).toEqual({
      model: "gpt-realtime-whisper",
      language: "zh",
      delay: "low",
    });
    expect(body.session.audio.input.turn_detection.eagerness).toBe("high");
    expect(body.session.audio.output).toEqual({ voice: "echo", speed: 1.15 });
    expect(body.session.truncation.token_limits.post_instructions).toBe(4000);
    expect((request?.headers as Record<string, string>).Authorization).toBe("Bearer server-key");
  });

  test("does not expose provider response bodies as success", async () => {
    const fetcher = async () => new Response("denied", { status: 401 });
    expect(createOpenAIClientSecret("bad", {
      model: "gpt-realtime-2.1-mini", maxOutputTokens: 10, contextTokenLimit: 100,
      preferences: { responseTiming: "natural", speechRate: 1 },
    }, fetcher)).rejects.toThrow("401");
  });

  test("rejects an already-expired client secret", async () => {
    const fetcher = async () => Response.json({ value: "ek_expired", expires_at: 999 });
    expect(createOpenAIClientSecret("key", {
      model: "gpt-realtime-2.1-mini", maxOutputTokens: 10, contextTokenLimit: 100,
      preferences: { responseTiming: "patient", speechRate: 0.9 },
    }, fetcher, () => 1_000_000)).rejects.toThrow("already-expired");
  });
});
