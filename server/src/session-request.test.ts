import { describe, expect, test } from "bun:test";
import { LEGACY_POST_BODY, OPENAI_POST_BODY } from "../../scripts/fixtures/session-wire.js";
import { parseSessionRequest } from "./session-request.js";

describe("parseSessionRequest", () => {
  test("parses the OpenAI POST fixture", () => {
    expect(parseSessionRequest(OPENAI_POST_BODY)).toEqual({
      protocol: "openai-live",
      sdp: OPENAI_POST_BODY.sdp,
      preferences: { responseTiming: "natural", speechRate: 1 },
    });
  });

  test("reads a legacy body with no protocol as the same OpenAI request", () => {
    expect(parseSessionRequest(LEGACY_POST_BODY)).toEqual(parseSessionRequest(OPENAI_POST_BODY));
  });

  test("rejects a body with no usable offer", () => {
    for (const body of [{}, { protocol: "openai-live" }, { protocol: "openai-live", sdp: " " }, { sdp: 1 }]) {
      expect(() => parseSessionRequest(body)).toThrow();
    }
  });

  test("rejects an unknown protocol", () => {
    expect(() => parseSessionRequest({ protocol: "gemini-live", sdp: OPENAI_POST_BODY.sdp })).toThrow();
    expect(() => parseSessionRequest({ protocol: 7, sdp: OPENAI_POST_BODY.sdp })).toThrow();
  });

  test("rejects a non-object body", () => {
    for (const body of [null, undefined, "v=0", 7, [OPENAI_POST_BODY]]) {
      expect(() => parseSessionRequest(body)).toThrow();
    }
  });

  test("rejects out-of-policy session preferences", () => {
    expect(() => parseSessionRequest({ ...LEGACY_POST_BODY, responseTiming: "instant" })).toThrow();
    expect(() => parseSessionRequest({ ...LEGACY_POST_BODY, speechRate: 2 })).toThrow();
  });

  test("ignores unknown extra keys", () => {
    expect(parseSessionRequest({ ...OPENAI_POST_BODY, model: "untrusted" })).toEqual(parseSessionRequest(OPENAI_POST_BODY));
  });
});
