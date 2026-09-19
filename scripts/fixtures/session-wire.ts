const OFFER_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n";
const ANSWER_SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";

export const READY_LEGACY_PAYLOAD = {} as const;
export const LEGACY_POST_BODY = { sdp: OFFER_SDP, responseTiming: "natural", speechRate: 1 } as const;
export const OPENAI_POST_BODY = { protocol: "openai-live", sdp: OFFER_SDP, responseTiming: "natural", speechRate: 1 } as const;
export const OPENAI_GRANT = { session: { id: "live_fixture" }, transport: { type: "webrtc", sdp: ANSWER_SDP } } as const;

export const READY_PLAN_PAYLOAD = { protocols: ["openai-live", "gemini-live"] } as const;
export const GEMINI_POST_BODY = { protocol: "gemini-live", responseTiming: "natural", speechRate: 1 } as const;
export const GEMINI_GRANT = {
  kind: "websocket-token",
  endpoint: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
  token: "auth_tokens/fixture",
  setup: { setup: { model: "models/gemini-3.8-live" } },
  expiresAt: "2026-09-19T12:30:00.000Z",
} as const;
