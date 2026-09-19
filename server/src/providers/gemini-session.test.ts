import { describe, expect, test } from "bun:test";
import { GEMINI_GRANT } from "../../../scripts/fixtures/session-wire.js";
import { createGeminiLiveGrant } from "./gemini-session.js";

const preferences = { responseTiming: "natural", speechRate: 1 } as const;
const now = () => Date.parse("2026-09-19T12:00:00.000Z");
const minted = { name: "auth_tokens/abc123" };

const LOCKED_FIELDS = "model,generationConfig,systemInstruction,tools,inputAudioTranscription,outputAudioTranscription,contextWindowCompression";

interface BoundSetup {
  model: string;
  generationConfig: { responseModalities: string[]; speechConfig: unknown; thinkingConfig?: unknown };
  systemInstruction: { parts: { text: string }[] };
  tools: { functionDeclarations: { name: string; behavior?: string }[] }[];
  inputAudioTranscription: unknown;
  outputAudioTranscription: unknown;
  contextWindowCompression: unknown;
  sessionResumption?: unknown;
}

interface Mint {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

async function mint(model: string, apiKey = "gemini-key") {
  let sent: Mint | undefined;
  const grant = await createGeminiLiveGrant(apiKey, { model, preferences }, async (url, init) => {
    sent = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return Response.json(minted);
  }, now);
  if (!sent) throw new Error("the issuer never called the fetcher");
  return { sent, grant, locked: sent.body.bidiGenerateContentSetup as BoundSetup };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the issuer resolved where it should have rejected");
}

describe("createGeminiLiveGrant", () => {
  test("mints a single-use token bound to the model and the full setup", async () => {
    const { sent, locked } = await mint("gemini-3.8-live");
    expect(sent.url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(sent.body.uses).toBe(1);
    expect(sent.body.expireTime).toBe("2026-09-19T12:30:00.000Z");
    expect(sent.body.newSessionExpireTime).toBe("2026-09-19T12:01:00.000Z");
    expect(locked.model).toBe("models/gemini-3.8-live");
  });

  test("locks exactly the seven masked fields and leaves resumption to the browser", async () => {
    const { sent, locked } = await mint("gemini-3.8-live");
    expect(sent.body.fieldMask).toBe(LOCKED_FIELDS);
    expect(Object.keys(locked)).not.toContain("sessionResumption");
    expect(locked.sessionResumption).toBeUndefined();
  });

  test("keeps the field mask and the locked fields from drifting apart", async () => {
    const { sent, locked } = await mint("gemini-3.8-live-extended-thinking");
    const masked = String(sent.body.fieldMask).split(",");
    expect(masked).toEqual(Object.keys(locked));
    for (const key of Object.keys(locked)) expect(masked).toContain(key);
    for (const key of masked) expect(Object.keys(locked)).toContain(key);
  });

  test("sends the key in a header and never in the URL or the body", async () => {
    const { sent } = await mint("gemini-3.8-live", "super-secret");
    expect(sent.headers.get("x-goog-api-key")).toBe("super-secret");
    expect(sent.url).not.toContain("super-secret");
    expect(JSON.stringify(sent.body)).not.toContain("super-secret");
  });

  test("binds transcription, the fixed voice and sliding-window compression", async () => {
    const { locked } = await mint("gemini-3.8-live");
    expect(locked.inputAudioTranscription).toEqual({});
    expect(locked.outputAudioTranscription).toEqual({});
    expect(locked.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(locked.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(locked.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } });
    expect(locked.systemInstruction.parts[0]?.text).toContain("perform_ui_actions");
    expect(locked.tools[0]?.functionDeclarations[0]?.name).toBe("perform_ui_actions");
  });

  test("adds thinkingLevel and NON_BLOCKING only on the extended model", async () => {
    const standard = await mint("gemini-3.8-live");
    expect(standard.locked.generationConfig.thinkingConfig).toBeUndefined();
    expect(standard.locked.tools[0]?.functionDeclarations[0]?.behavior).toBeUndefined();

    const extended = await mint("gemini-3.8-live-extended-thinking");
    expect(extended.locked.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(extended.locked.tools[0]?.functionDeclarations[0]?.behavior).toBe("NON_BLOCKING");
  });

  test("returns the websocket-token grant the browser dials", async () => {
    const { grant } = await mint("gemini-3.8-live");
    expect(Object.keys(grant).sort()).toEqual(Object.keys(GEMINI_GRANT).sort());
    expect(grant.kind).toBe(GEMINI_GRANT.kind);
    expect(grant.token).toBe("auth_tokens/abc123");
    expect(grant.expiresAt).toBe("2026-09-19T12:30:00.000Z");
    expect(grant.endpoint.startsWith("wss://generativelanguage.googleapis.com/ws/")).toBe(true);
    expect(grant.endpoint).toContain("BidiGenerateContentConstrained");
    expect(grant.endpoint).not.toContain("?");
  });

  test("switches resumption on in the browser setup frame and changes nothing else", async () => {
    const { grant, locked } = await mint("gemini-3.8-live");
    const { sessionResumption, ...rest } = grant.setup.setup;
    expect(sessionResumption).toEqual({});
    expect(rest).toEqual(locked as unknown as Record<string, unknown>);
  });

  test("rejects a blank key and a failed mint without leaking the key", async () => {
    expect(await rejection(createGeminiLiveGrant("", { model: "gemini-3.8-live", preferences }))).toContain("GEMINI_API_KEY");
    const message = await rejection(createGeminiLiveGrant("leak-me", { model: "gemini-3.8-live", preferences }, async () => new Response("google secret", { status: 403 }), now));
    expect(message).toContain("403");
    expect(message).not.toContain("leak-me");
    expect(message).not.toContain("google secret");
  });

  test("rejects a malformed token response", async () => {
    for (const payload of [null, {}, { name: " " }, { token: "auth_tokens/x" }]) {
      expect(await rejection(createGeminiLiveGrant("key", { model: "gemini-3.8-live", preferences }, async () => Response.json(payload), now))).toContain("Invalid Gemini auth token");
    }
  });
});
