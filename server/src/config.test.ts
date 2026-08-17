import { describe, expect, test } from "bun:test";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  test("requires the server-only API key and normalizes exact origins", () => {
    expect(() => readConfig({})).toThrow("OPENAI_API_KEY");
    const config = readConfig({ OPENAI_API_KEY: " secret ", ALLOWED_ORIGINS: "https://voice.example/, http://localhost:5180" });
    expect(config.apiKey).toBe("secret");
    expect(config.model).toBe("gpt-realtime-2.1-mini");
    expect(config.allowedOrigins).toEqual(["https://voice.example", "http://localhost:5180"]);
  });

  test("rejects invalid startup limits and origin protocols", () => {
    expect(() => readConfig({ OPENAI_API_KEY: "key", SERVER_PORT: "3010" })).toThrow("SERVER_PORT");
    expect(() => readConfig({ OPENAI_API_KEY: "key", MAX_OUTPUT_TOKENS: "4097" })).toThrow("MAX_OUTPUT_TOKENS");
    expect(() => readConfig({ OPENAI_API_KEY: "key", ALLOWED_ORIGINS: "javascript:alert(1)" })).toThrow("protocol");
  });
});
