import { describe, expect, test } from "bun:test";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  test("requires at least one provider key and normalizes exact origins", () => {
    expect(() => readConfig({})).toThrow("OPENAI_API_KEY");
    const config = readConfig({ OPENAI_API_KEY: " secret ", ALLOWED_ORIGINS: "https://voice.example/, http://localhost:5180" });
    expect(config.providers).toEqual([{ protocol: "openai-live", apiKey: "secret", model: "gpt-live-1", backendModel: "gpt-5.6-luna", maxOutputTokens: 768 }]);
    expect(config.allowedOrigins).toEqual(["https://voice.example", "http://localhost:5180"]);
  });

  test("boots on a Gemini key alone with the default Live model", () => {
    const config = readConfig({ GEMINI_API_KEY: " gem " });
    expect(config.providers).toEqual([{ protocol: "gemini-live", apiKey: "gem", model: "gemini-3.8-live" }]);
  });

  test("reads the extended Gemini model and rejects any other", () => {
    expect(readConfig({ GEMINI_API_KEY: "gem", GEMINI_LIVE_MODEL: "gemini-3.8-live-extended-thinking" }).providers[0]).toMatchObject({ model: "gemini-3.8-live-extended-thinking" });
    expect(() => readConfig({ GEMINI_API_KEY: "gem", GEMINI_LIVE_MODEL: "gemini-2.0-flash-live" })).toThrow("GEMINI_LIVE_MODEL");
  });

  test("rejects a Gemini backend model because Gemini has no delegation protocol", () => {
    expect(() => readConfig({ GEMINI_API_KEY: "gem", GEMINI_LIVE_BACKEND_MODEL: "gemini-3.8-pro" })).toThrow("delegation protocol");
  });

  test("holds both keyed providers with OpenAI first and follows LIVE_PROVIDERS order", () => {
    expect(readConfig({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "gem" }).providers.map((provider) => provider.protocol)).toEqual(["openai-live", "gemini-live"]);
    expect(readConfig({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "gem", LIVE_PROVIDERS: "gemini-live, openai-live" }).providers.map((provider) => provider.protocol)).toEqual(["gemini-live", "openai-live"]);
    expect(readConfig({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "gem", LIVE_PROVIDERS: "gemini-live" }).providers.map((provider) => provider.protocol)).toEqual(["gemini-live"]);
  });

  test("rejects a LIVE_PROVIDERS entry with no key and an unknown protocol", () => {
    expect(() => readConfig({ OPENAI_API_KEY: "k", LIVE_PROVIDERS: "gemini-live" })).toThrow("gemini-live");
    expect(() => readConfig({ OPENAI_API_KEY: "k", LIVE_PROVIDERS: "anthropic-live" })).toThrow("anthropic-live");
  });

  test("rejects a LIVE_PROVIDERS entry listed more than once", () => {
    expect(() => readConfig({ GEMINI_API_KEY: "gem", LIVE_PROVIDERS: "gemini-live,gemini-live" })).toThrow("LIVE_PROVIDERS lists gemini-live more than once");
    expect(() => readConfig({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "gem", LIVE_PROVIDERS: "openai-live, gemini-live , openai-live" })).toThrow("LIVE_PROVIDERS lists openai-live more than once");
  });

  test("rejects invalid startup limits and origin protocols", () => {
    expect(() => readConfig({ OPENAI_API_KEY: "key", PORT: "99999" })).toThrow("PORT");
    expect(() => readConfig({ OPENAI_API_KEY: "key", MAX_OUTPUT_TOKENS: "4097" })).toThrow("MAX_OUTPUT_TOKENS");
    expect(() => readConfig({ OPENAI_API_KEY: "key", ALLOWED_ORIGINS: "javascript:alert(1)" })).toThrow("protocol");
  });

  test("defaults and reads the concurrent lifetime stream cap", () => {
    expect(readConfig({ OPENAI_API_KEY: "key" }).lifetimeStreamsPerOrigin).toBe(4);
    expect(readConfig({ OPENAI_API_KEY: "key", LIFETIME_STREAMS_PER_ORIGIN: "12" }).lifetimeStreamsPerOrigin).toBe(12);
    expect(() => readConfig({ OPENAI_API_KEY: "key", LIFETIME_STREAMS_PER_ORIGIN: "0" })).toThrow("LIFETIME_STREAMS_PER_ORIGIN");
  });

  test("boots with no TypeSafe key and leaves interpretation unconfigured", () => {
    expect(readConfig({ OPENAI_API_KEY: "key" }).typesafe).toBeUndefined();
    expect(readConfig({ OPENAI_API_KEY: "key", TYPESAFE_API_KEY: "   " }).typesafe).toBeUndefined();
  });

  test("trims the TypeSafe key and pins the default model", () => {
    expect(readConfig({ OPENAI_API_KEY: "key", TYPESAFE_API_KEY: " ts-secret " }).typesafe).toEqual({ apiKey: "ts-secret", model: "jev-1.13.0" });
  });

  test("reads a custom TypeSafe model", () => {
    expect(readConfig({ OPENAI_API_KEY: "key", TYPESAFE_API_KEY: "ts", TYPESAFE_MODEL: " jev-latest " }).typesafe).toEqual({ apiKey: "ts", model: "jev-latest" });
    expect(readConfig({ OPENAI_API_KEY: "key", TYPESAFE_API_KEY: "ts", TYPESAFE_MODEL: "  " }).typesafe).toEqual({ apiKey: "ts", model: "jev-1.13.0" });
  });

  test("defaults and reads the interpret rate window", () => {
    const config = readConfig({ OPENAI_API_KEY: "key" });
    expect(config.interpretRateLimitRequests).toBe(120);
    expect(config.interpretRateLimitWindowMs).toBe(60_000);
    const custom = readConfig({ OPENAI_API_KEY: "key", INTERPRET_RATE_LIMIT_REQUESTS: "30", INTERPRET_RATE_LIMIT_WINDOW_MS: "15000" });
    expect(custom.interpretRateLimitRequests).toBe(30);
    expect(custom.interpretRateLimitWindowMs).toBe(15_000);
  });

  test("rejects an invalid interpret rate window", () => {
    expect(() => readConfig({ OPENAI_API_KEY: "key", INTERPRET_RATE_LIMIT_REQUESTS: "0" })).toThrow("INTERPRET_RATE_LIMIT_REQUESTS");
    expect(() => readConfig({ OPENAI_API_KEY: "key", INTERPRET_RATE_LIMIT_WINDOW_MS: "half a minute" })).toThrow("INTERPRET_RATE_LIMIT_WINDOW_MS");
  });

  test("reads Live model and backend settings independently", () => {
    expect(readConfig({ OPENAI_API_KEY: "key" }).providers[0]).toMatchObject({ model: "gpt-live-1", backendModel: "gpt-5.6-luna" });
    expect(readConfig({ OPENAI_API_KEY: "key", OPENAI_LIVE_MODEL: "gpt-live-custom" }).providers[0]).toMatchObject({ model: "gpt-live-custom" });
    expect(readConfig({ OPENAI_API_KEY: "key", OPENAI_LIVE_BACKEND_MODEL: "gpt-5.6-terra" }).providers[0]).toMatchObject({ backendModel: "gpt-5.6-terra" });
    expect(() => readConfig({ OPENAI_API_KEY: "key", MAX_OUTPUT_TOKENS: "15" })).toThrow("at least 16");
  });
});
