import { describe, expect, test } from "bun:test";
import { createOpenAILiveSession } from "./openai-session.js";

const answer = { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } } as const;
const policy = { model: "gpt-live-1", backendModel: "gpt-5.6-luna", maxOutputTokens: 768, preferences: { responseTiming: "natural", speechRate: 1 } } as const;
type ActionVariantSchema = { required: string[]; properties: { type: { enum: string[] }; target?: { enum: string[] }; direction?: { enum: string[] }; value?: { enum: string[] } } };

describe("createOpenAILiveSession", () => {
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
