import { describe, expect, test } from "bun:test";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  test("requires the server-only API key and normalizes exact origins", () => {
    expect(() => readConfig({})).toThrow("OPENAI_API_KEY");
    const config = readConfig({ OPENAI_API_KEY: " secret ", ALLOWED_ORIGINS: "https://voice.example/, http://localhost:5180" });
    expect(config.apiKey).toBe("secret");
    expect(config.model).toBe("gpt-live-1");
    expect(config.allowedOrigins).toEqual(["https://voice.example", "http://localhost:5180"]);
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

  test("reads Live model and backend settings independently", () => {
    expect(readConfig({ OPENAI_API_KEY: "key" }).model).toBe("gpt-live-1");
    expect(readConfig({ OPENAI_API_KEY: "key" }).backendModel).toBe("gpt-5.6-luna");
    expect(readConfig({ OPENAI_API_KEY: "key", OPENAI_LIVE_MODEL: "gpt-live-custom" }).model).toBe("gpt-live-custom");
    expect(readConfig({ OPENAI_API_KEY: "key", OPENAI_LIVE_BACKEND_MODEL: "gpt-5.6-terra" }).backendModel).toBe("gpt-5.6-terra");
    expect(() => readConfig({ OPENAI_API_KEY: "key", MAX_OUTPUT_TOKENS: "15" })).toThrow("at least 16");
  });
});
