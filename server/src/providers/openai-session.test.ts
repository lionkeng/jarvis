import { describe, expect, test } from "bun:test";
import { createOpenAILiveSession } from "./openai-session.js";

const answer = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } } as const;
const policy = { model: "gpt-live-1", backendModel: "gpt-5.6-luna", maxOutputTokens: 768, preferences: { responseTiming: "natural", speechRate: 1 } } as const;
type ActionVariantSchema = { required: string[]; properties: { type: { enum: string[] }; target?: { enum: string[] }; direction?: { enum: string[] }; value?: { enum: string[] } } };

const BODY_BEFORE_THE_POLICY_EXTRACT = "{\"session\":{\"model\":\"gpt-live-1\",\"audio\":{\"output\":{\"voice\":\"marin\"}},\"instructions\":\"Answer ordinary questions in one or two short sentences unless asked for detail. Match the user's language.\\nDelegate every UI change to the backend without a spoken preamble. Delegate requests needing reasoning or information you do not know.\\nOnly announce UI success after the backend verifies it, in one short sentence without internal action names, IDs, JSON, or action counts.\\nFor a failed action, explain briefly. For a cancelled action, do not volunteer an acknowledgement. Speech interruptions alone do not cancel backend work.\\nUse a natural conversational pace and allow the user to finish.\\nAim for a speaking pace of 1 times normal.\",\"delegation\":{\"type\":\"responses\",\"responses\":{\"model\":\"gpt-5.6-luna\",\"max_output_tokens\":768,\"reasoning\":{\"effort\":\"low\"},\"tools\":[{\"type\":\"function\",\"name\":\"perform_ui_actions\",\"strict\":false,\"description\":\"Put every ordered action for one user request in a single call. Navigate goes to a page. Open and close only the library details panel. Select library items or themes, scroll named regions, focus dashboard search, or activate the article bookmark.\",\"parameters\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"actions\"],\"properties\":{\"actions\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":5,\"items\":{\"oneOf\":[{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"navigate\"]},\"target\":{\"type\":\"string\",\"enum\":[\"dashboard\",\"library\",\"article\",\"settings\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"open\"]},\"target\":{\"type\":\"string\",\"enum\":[\"library.details\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"close\"]},\"target\":{\"type\":\"string\",\"enum\":[\"library.details\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\",\"value\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"select\"]},\"target\":{\"type\":\"string\",\"enum\":[\"library.item\"]},\"value\":{\"type\":\"string\",\"enum\":[\"atlas\",\"beacon\",\"cinder\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\",\"value\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"select\"]},\"target\":{\"type\":\"string\",\"enum\":[\"settings.theme\"]},\"value\":{\"type\":\"string\",\"enum\":[\"light\",\"dark\",\"system\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\",\"direction\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"scroll\"]},\"target\":{\"type\":\"string\",\"enum\":[\"article.content\",\"library.results\"]},\"direction\":{\"type\":\"string\",\"enum\":[\"up\",\"down\",\"top\",\"bottom\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"focus\"]},\"target\":{\"type\":\"string\",\"enum\":[\"dashboard.search\"]}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"type\",\"target\"],\"properties\":{\"type\":{\"type\":\"string\",\"enum\":[\"activate\"]},\"target\":{\"type\":\"string\",\"enum\":[\"article.bookmark\"]}}}]}}}}}],\"tool_choice\":\"auto\",\"parallel_tool_calls\":false,\"instructions\":\"Answer. Direct informational answers use one or two short sentences unless the user asks for detail.\\nAct. UI mutation requests call perform_ui_actions without a spoken preamble. Ordinary questions never call the UI tool.\\nNavigate. Opening dashboard, library, article, or settings means navigation. open is reserved for the library details panel.\\nCompound. A request containing several UI changes becomes one tool call with ordered actions.\\nScroll. Unqualified scroll means one downward scroll on the named or implied page content. Explicit up, top, bottom, or down wording takes precedence.\\nExample. Open article and scroll means navigate to the article and then scroll article.content down in the same call.\\nClarify. Ask at most one short clarification only when a required target or value truly cannot be inferred from the closed demo grammar.\\nResult. Do not claim success before a successful tool result. After a failure, state the result briefly and do not invent a retry.\\nSchema. Never invent CSS selectors, pointer coordinates, JavaScript, URLs, or targets outside the tool schema.\\nReturn concise verified facts for the voice model. After a function result, summarize it without repeating the operation. Report cancellation as cancelled and do not retry it.\"}}},\"transport\":{\"type\":\"webrtc\",\"sdp\":\"v=0\\r\\noffer\"}}";

describe("createOpenAILiveSession", () => {
  test("posts the same bytes it posted before the demo policy was extracted", async () => {
    let posted: string | undefined;
    await createOpenAILiveSession("server-key", "v=0\r\noffer", policy, async (_url, init) => {
      posted = String(init?.body);
      return Response.json(answer);
    });
    expect(posted).toBe(BODY_BEFORE_THE_POLICY_EXTRACT);
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
  test("advertises a closed perform_ui_actions action grammar", async () => {
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
    const parameters = body.session.delegation.responses.tools[0].parameters;
    const actions = parameters.properties.actions;
    const items = actions.items;
    const variants = items.oneOf;

    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required).toEqual(["actions"]);
    expect(actions.minItems).toBe(1);
    expect(actions.maxItems).toBe(5);
    expect(items.properties).toBeUndefined();
    expect(items.required).toBeUndefined();
    expect(variants).toHaveLength(8);

    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target"],
      properties: {
        type: { type: "string", enum: ["navigate"] },
        target: { type: "string", enum: ["dashboard", "library", "article", "settings"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target"],
      properties: {
        type: { type: "string", enum: ["open"] },
        target: { type: "string", enum: ["library.details"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target"],
      properties: {
        type: { type: "string", enum: ["close"] },
        target: { type: "string", enum: ["library.details"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target", "value"],
      properties: {
        type: { type: "string", enum: ["select"] },
        target: { type: "string", enum: ["library.item"] },
        value: { type: "string", enum: ["atlas", "beacon", "cinder"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target", "value"],
      properties: {
        type: { type: "string", enum: ["select"] },
        target: { type: "string", enum: ["settings.theme"] },
        value: { type: "string", enum: ["light", "dark", "system"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target", "direction"],
      properties: {
        type: { type: "string", enum: ["scroll"] },
        target: { type: "string", enum: ["article.content", "library.results"] },
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target"],
      properties: {
        type: { type: "string", enum: ["focus"] },
        target: { type: "string", enum: ["dashboard.search"] },
      },
    });
    expect(variants).toContainEqual({
      type: "object",
      additionalProperties: false,
      required: ["type", "target"],
      properties: {
        type: { type: "string", enum: ["activate"] },
        target: { type: "string", enum: ["article.bookmark"] },
      },
    });

    const navigate = variants.find((variant: ActionVariantSchema) => variant.properties.type.enum.includes("navigate"));
    const open = variants.find((variant: ActionVariantSchema) => variant.properties.type.enum.includes("open"));
    const scroll = variants.find((variant: ActionVariantSchema) => variant.properties.type.enum.includes("scroll"));

    expect(navigate.properties.target.enum).toContain("library");
    expect(navigate.properties.target.enum).toContain("article");
    expect(navigate.properties.direction).toBeUndefined();
    expect(navigate.properties.value).toBeUndefined();
    expect(open.properties.target.enum).toEqual(["library.details"]);
    expect(open.properties.target.enum).not.toContain("library");
    expect(open.properties.target.enum).not.toContain("article");
    expect(scroll.required).toContain("direction");
    expect(scroll.properties.target.enum).toContain("article.content");
    expect(scroll.properties.direction.enum).toEqual(["up", "down", "top", "bottom"]);
    expect(scroll.properties.direction.enum).toContain("down");
    expect(scroll.properties.direction.enum).toContain("bottom");

    expect(variants.some((variant: ActionVariantSchema) => (
      variant.properties.type.enum.includes("navigate") && variant.properties.direction !== undefined
    ))).toBe(false);
    expect(variants.some((variant: ActionVariantSchema) => (
      variant.properties.type.enum.includes("scroll") && !variant.required.includes("direction")
    ))).toBe(false);
    expect(variants.some((variant: ActionVariantSchema) => (
      variant.properties.type.enum.includes("open") && variant.properties.target?.enum.includes("library") === true
    ))).toBe(false);
    expect(variants.some((variant: ActionVariantSchema) => (
      variant.properties.type !== undefined
      && variant.properties.target !== undefined
      && variant.properties.direction !== undefined
      && variant.properties.value !== undefined
    ))).toBe(false);
  });

});
