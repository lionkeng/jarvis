import { parseSessionPreferences, type SessionPreferences } from "./session-preferences.js";

export const LIVE_PROTOCOLS = ["openai-live"] as const;

export type ProtocolId = typeof LIVE_PROTOCOLS[number];

export interface OpenAILiveRequest {
  protocol: "openai-live";
  sdp: string;
  preferences: SessionPreferences;
}

export type SessionRequest = OpenAILiveRequest;

export function parseSessionRequest(body: unknown): SessionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A session request must be an object");
  const candidate = body as Record<string, unknown>;
  const preferences = parseSessionPreferences(candidate);
  const protocol = liveProtocol(candidate.protocol);
  switch (protocol) {
    case "openai-live":
      return { protocol, sdp: offerSdp(candidate.sdp), preferences };
  }
}

function liveProtocol(value: unknown): ProtocolId {
  if (value === undefined) return "openai-live";
  if (typeof value !== "string" || !LIVE_PROTOCOLS.includes(value as ProtocolId)) throw new Error(`Unsupported live protocol: ${String(value)}`);
  return value as ProtocolId;
}

function offerSdp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("An SDP offer is required");
  return value;
}
