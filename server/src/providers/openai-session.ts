import { renderOpenAIPolicy } from "./demo-agent-policy.js";
import type { SessionPreferences } from "../session-preferences.js";

export interface OpenAISessionPolicy {
  model: string;
  backendModel: string;
  maxOutputTokens: number;
  preferences: SessionPreferences;
}

export interface LiveSessionResponse {
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function createOpenAILiveSession(apiKey: string, sdp: string, policy: OpenAISessionPolicy, fetcher: FetchLike = fetch): Promise<LiveSessionResponse> {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const rendering = renderOpenAIPolicy(policy.preferences);
  const response = await fetcher("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      session: {
        model: policy.model,
        audio: { output: { voice: "marin" } },
        instructions: rendering.instructions,
        delegation: {
          type: "responses",
          responses: {
            model: policy.backendModel,
            max_output_tokens: policy.maxOutputTokens,
            reasoning: { effort: "low" },
            tools: [rendering.tool],
            tool_choice: "auto",
            parallel_tool_calls: false,
            instructions: rendering.backendInstructions,
          },
        },
      },
      transport: { type: "webrtc", sdp },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Live session request failed with status ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("session" in payload) || !("transport" in payload)) throw new Error("Invalid Live session response");
  const { session, transport } = payload;
  if (!session || typeof session !== "object" || !("id" in session) || typeof session.id !== "string" || !session.id.trim()
    || !transport || typeof transport !== "object" || !("type" in transport) || transport.type !== "webrtc"
    || !("sdp" in transport) || typeof transport.sdp !== "string" || !transport.sdp.trim()) throw new Error("Invalid Live session response");
  return { session: { id: session.id }, transport: { type: "webrtc", sdp: transport.sdp } };
}
