import { describe, expect, test } from "bun:test";
import { createOpenAILiveSession } from "./openai-session.js";

const answer = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } } as const;
const policy = { model: "gpt-live-1", backendModel: "gpt-5.6-luna", maxOutputTokens: 768, preferences: { responseTiming: "natural", speechRate: 1 } } as const;

const POSTED_SESSION_BODY = "{\"session\":{\"model\":\"gpt-live-1\",\"audio\":{\"output\":{\"voice\":\"marin\"}},\"instructions\":\"Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.\\nDelegate every UI change to the backend without a spoken preamble. Delegate requests needing reasoning or information you do not know.\\nOnly announce UI success after the backend verifies it, in one short sentence without internal control names, IDs, JSON, or request counts.\\nFor a failed request, explain briefly. For a cancelled request, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.\\nUse a natural conversational pace and allow the user to finish.\\nAim for a speaking pace of 1 times normal.\",\"delegation\":{\"type\":\"responses\",\"responses\":{\"model\":\"gpt-5.6-luna\",\"max_output_tokens\":768,\"reasoning\":{\"effort\":\"low\"},\"tools\":[{\"type\":\"function\",\"name\":\"request_ui_changes\",\"strict\":false,\"description\":\"Apply one or more changes to the app's screen. Each entry in requests is one self-contained imperative English sentence describing one change, in the order to apply them. Keep the user's size, color, and ordinal words. Resolve pronouns and references from the conversation. Split a compound request into one sentence per change. Translate other languages to English.\",\"parameters\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"requests\"],\"properties\":{\"requests\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":5,\"items\":{\"type\":\"string\",\"minLength\":1}}}}}],\"tool_choice\":\"auto\",\"parallel_tool_calls\":false,\"instructions\":\"Answer. Direct informational answers use one or two short sentences unless the user asks for detail.\\nAct. UI change requests call request_ui_changes without a spoken preamble. Ordinary questions never call it.\\nSentences. Each request is one self-contained imperative English sentence naming what to change and how, such as 'select the Atlas card' or 'scroll the article to the bottom'. Keep the user's size words, color words, and ordinals. Name the page, card, panel, or setting plainly, as the user did, and never fold one change into another.\\nCompound. A request with several UI changes becomes one call with one sentence per change, in order.\\nExample. 'Open the article and scroll to the bottom' becomes two sentences: 'go to the article page' and 'scroll the article to the bottom'.\\nClarify. When a result's status is unclear, ask the user the question in the result's message. When they answer, send a new self-contained sentence. Ask at most one clarification.\\nResult. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.\\nSchema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or control names. Describe the change in words.\\nReturn concise verified facts for the voice model. After a function result, summarize it without repeating the operation. Report cancellation as cancelled and do not retry it.\"}}},\"transport\":{\"type\":\"webrtc\",\"sdp\":\"v=0\\r\\noffer\"}}";

describe("createOpenAILiveSession", () => {
  test("posts today's rendered policy bytes for the Live session", async () => {
    let posted: string | undefined;
    await createOpenAILiveSession("server-key", "v=0\r\noffer", policy, async (_url, init) => {
      posted = String(init?.body);
      return Response.json(answer);
    });
    expect(posted).toBe(POSTED_SESSION_BODY);
  });

  test("exchanges JSON SDP with server-owned voice and backend configuration", async () => {
    const result = await createOpenAILiveSession("server-key", "v=0\r\noffer", policy, async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/live/sessions");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-key");
      const body = JSON.parse(String(init?.body));
      expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0\r\noffer" });
      expect(body.session.model).toBe("gpt-live-1");
      expect(body.session.audio).toEqual({ output: { voice: "marin" } });
      expect(body.session.delegation.type).toBe("responses");
      expect(body.session.delegation.responses).toMatchObject({ model: "gpt-5.6-luna", max_output_tokens: 768, parallel_tool_calls: false });
      expect(body.session.delegation.responses.tools[0].strict).toBe(false);
      expect(body.session.instructions).toContain("Delegate every UI change");
      expect(body.session.delegation.responses.instructions).toContain("Never invent CSS selectors");
      expect(body.session.delegation.responses.tools[0].name).toBe("request_ui_changes");
      for (const field of ["type", "tools", "tracing", "truncation", "max_output_tokens", "reasoning"]) expect(body.session[field]).toBeUndefined();
      return Response.json({ ...answer, secret: "never forward" });
    });
    expect(result).toEqual(answer);
  });

  test("uses conversation instructions for pacing without unsupported audio fields", async () => {
    await createOpenAILiveSession("key", "v=0", { ...policy, preferences: { responseTiming: "patient", speechRate: 0.9 } }, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.session.instructions).toContain("extra time");
      expect(body.session.instructions).toContain("0.9 times normal");
      expect(body.session.audio.output.speed).toBeUndefined();
      expect(body.session.audio.input).toBeUndefined();
      return Response.json(answer);
    });
  });

  test("rejects provider errors and malformed session responses", async () => {
    await expect(createOpenAILiveSession("key", "v=0", policy, async () => new Response("secret", { status: 401 }))).rejects.toThrow("401");
    for (const payload of [null, {}, { value: "ek_old" }, { ...answer, transport: { type: "webrtc", sdp: "" } }, { ...answer, session: { id: "" } }]) {
      await expect(createOpenAILiveSession("key", "v=0", policy, async () => Response.json(payload))).rejects.toThrow("Invalid Live session");
    }
  });
  test("advertises the one static request_ui_changes tool", async () => {
    let request: RequestInit | undefined;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify(answer), { status: 200 });
    };
    await createOpenAILiveSession("server-key", "v=0", {
      model: "gpt-live-1", backendModel: "gpt-5.6-luna",
      maxOutputTokens: 10,
      preferences: { responseTiming: "natural", speechRate: 1 },
    }, fetcher);
    const body = JSON.parse(String(request?.body));
    const tools = body.session.delegation.responses.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("request_ui_changes");
    expect(tools[0].strict).toBe(false);
    const parameters = tools[0].parameters;
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required).toEqual(["requests"]);
    expect(Object.keys(parameters.properties)).toEqual(["requests"]);
    const requests = parameters.properties.requests;
    expect(requests.type).toBe("array");
    expect(requests.minItems).toBe(1);
    expect(requests.maxItems).toBe(5);
    expect(requests.items).toEqual({ type: "string", minLength: 1 });
    expect(JSON.stringify(tools)).not.toContain("enum");
    expect(JSON.stringify(tools)).not.toContain("oneOf");
  });

});
