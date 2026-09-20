import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerLease, parseGrant, parsePlan } from "./broker.js";
import { GEMINI_GRANT, GEMINI_POST_BODY, LEGACY_POST_BODY, OPENAI_GRANT, OPENAI_POST_BODY, READY_LEGACY_PAYLOAD, READY_PLAN_PAYLOAD } from "../../../../scripts/fixtures/session-wire.js";

afterEach(() => { vi.unstubAllGlobals(); });

const preferences = { responseTiming: LEGACY_POST_BODY.responseTiming, speechRate: LEGACY_POST_BODY.speechRate };
const answer = { kind: "webrtc-answer", sessionId: OPENAI_GRANT.session.id, answerSdp: OPENAI_GRANT.transport.sdp };

function stubBroker(ready: string, granted: unknown = OPENAI_GRANT) {
  const fetcher = vi.fn(async (_input: unknown, init: RequestInit | undefined) => init?.method === "GET"
    ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${ready}\n\n`)); },
    }), { headers: { "Content-Type": "text/event-stream" } })
    : Response.json(granted, { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const lease = new BrokerLease({ endpoint: "/session", signal: new AbortController().signal, guard: () => undefined, lost: () => undefined });
  return { lease, body: () => JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as Record<string, unknown> };
}

describe("Live broker contract", () => {
  it("reads the legacy ready payload as the single OpenAI protocol", () => {
    expect(parsePlan(READY_LEGACY_PAYLOAD)).toEqual(["openai-live"]);
    expect(parsePlan({ protocols: ["openai-live"] })).toEqual(["openai-live"]);
    expect(parsePlan({ protocols: ["openai-live", "carrier-pigeon"] })).toEqual(["openai-live"]);
    for (const payload of [{ protocols: [] }, { protocols: ["carrier-pigeon"] }, { protocols: "openai-live" }]) {
      expect(() => parsePlan(payload)).toThrow("no usable live protocol");
    }
  });

  it("maps the OpenAI grant to a webrtc answer and rejects anything else", () => {
    expect(parseGrant(OPENAI_GRANT)).toEqual(answer);
    for (const payload of [null, [], {}, { value: "ek_old" }, { ...OPENAI_GRANT, transport: { type: "websocket", sdp: "wss://" } }]) {
      expect(() => parseGrant(payload)).toThrow("invalid Live session");
    }
  });

  it("omits the protocol from the grant request when the lease announced no plan", async () => {
    const broker = stubBroker(JSON.stringify(READY_LEGACY_PAYLOAD));
    expect(await broker.lease.open()).toEqual(["openai-live"]);
    expect(await broker.lease.grant("openai-live", preferences, { sdp: LEGACY_POST_BODY.sdp })).toEqual(answer);
    expect(broker.body()).toEqual(LEGACY_POST_BODY);
    expect(broker.body()).not.toHaveProperty("protocol");
    broker.lease.release();
  });

  it("names the protocol in the grant request when the lease announced a plan", async () => {
    const broker = stubBroker(JSON.stringify({ protocols: ["openai-live"] }));
    expect(await broker.lease.open()).toEqual(["openai-live"]);
    expect(await broker.lease.grant("openai-live", preferences, { sdp: OPENAI_POST_BODY.sdp })).toEqual(answer);
    expect(broker.body()).toEqual(OPENAI_POST_BODY);
    broker.lease.release();
  });

  it("reads the two-protocol ready payload in the order the broker offered", () => {
    expect(parsePlan(READY_PLAN_PAYLOAD)).toEqual(["openai-live", "gemini-live"]);
    expect(parsePlan({ protocols: ["gemini-live"] })).toEqual(["gemini-live"]);
  });

  it("maps the Gemini grant to a websocket token and rejects an unencrypted endpoint", () => {
    expect(parseGrant(GEMINI_GRANT)).toEqual({
      kind: "websocket-token",
      endpoint: GEMINI_GRANT.endpoint,
      token: GEMINI_GRANT.token,
      setup: GEMINI_GRANT.setup,
      expiresAt: Date.parse(GEMINI_GRANT.expiresAt),
    });
    for (const payload of [
      { ...GEMINI_GRANT, endpoint: "http://generativelanguage.googleapis.com/ws" },
      { ...GEMINI_GRANT, endpoint: "ws://generativelanguage.googleapis.com/ws" },
      { ...GEMINI_GRANT, token: " " },
      { ...GEMINI_GRANT, setup: "models/gemini-3.8-live" },
      { ...GEMINI_GRANT, expiresAt: "soon" },
      { ...GEMINI_GRANT, expiresAt: undefined },
    ]) expect(() => parseGrant(payload)).toThrow("invalid Live session");
  });

  it("asks for a Gemini session with the protocol and the preferences alone", async () => {
    const broker = stubBroker(JSON.stringify(READY_PLAN_PAYLOAD), GEMINI_GRANT);
    expect(await broker.lease.open()).toEqual(["openai-live", "gemini-live"]);
    expect(await broker.lease.grant("gemini-live", preferences)).toMatchObject({ kind: "websocket-token" });
    expect(broker.body()).toEqual(GEMINI_POST_BODY);
    broker.lease.release();
  });
});
