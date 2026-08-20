import { describe, expect, test } from "bun:test";
import { createOpenAIClientSecret } from "./openai-session.js";

type ActionVariantSchema = {
  required: string[];
  properties: {
    type: { enum: string[] };
    target?: { enum: string[] };
    direction?: { enum: string[] };
    value?: { enum: string[] };
  };
};

describe("createOpenAIClientSecret", () => {
  test("calls the GA endpoint and applies server-owned caps", async () => {
    let request: RequestInit | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/realtime/client_secrets");
      request = init;
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 2_000 }), { status: 200 });
    });
    const result = await createOpenAIClientSecret("server-key", {
      model: "gpt-realtime-2.1-mini",
      maxOutputTokens: 512,
      contextTokenLimit: 4000,
      preferences: { responseTiming: "fast", speechRate: 1.15 },
      realtimeTracing: true,
    }, fetcher, () => 1_000_000);
    expect(result.value).toBe("ek_test");
    const body = JSON.parse(String(request?.body));
    expect(body.session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1-mini", max_output_tokens: 512 });
    expect(body.session.reasoning).toEqual({ effort: "minimal" });
    expect(body.session.audio.input.transcription).toEqual({
      model: "gpt-realtime-whisper",
      language: "zh",
      delay: "low",
    });
    expect(body.session.audio.input.turn_detection.eagerness).toBe("high");
    expect(body.session.audio.output).toEqual({ voice: "echo", speed: 1.15 });
    expect(body.session.truncation.token_limits.post_instructions).toBe(4000);
    expect(body.session.tracing).toBe("auto");
    expect(body.session.tool_choice).toBe("auto");
    expect(body.session.parallel_tool_calls).toBe(false);
    expect(body.session.tools).toHaveLength(1);
    expect(body.session.tools[0].name).toBe("perform_ui_actions");
    expect(body.session.tools[0].type).toBe("function");
    expect(body.session.tools[0].parameters.additionalProperties).toBe(false);
    expect(body.session.tools[0].parameters.required).toEqual(["actions"]);
    expect(body.session.tools[0].parameters.properties.actions.minItems).toBe(1);
    expect(body.session.tools[0].parameters.properties.actions.maxItems).toBe(5);
    expect(body.session.tools[0].parameters.properties.actions.items.properties).toBeUndefined();
    expect(body.session.tools[0].parameters.properties.actions.items.oneOf).toHaveLength(8);
    expect(body.session.instructions).toContain("perform_ui_actions");
    expect(body.session.instructions).toContain("without a spoken preamble");
    expect(body.session.instructions).toContain("Ordinary questions never call the UI tool");
    expect(body.session.instructions).toContain("Never invent CSS selectors, pointer coordinates, JavaScript, URLs");
    expect((request?.headers as Record<string, string>).Authorization).toBe("Bearer server-key");
  });

  test("does not expose provider response bodies as success", async () => {
    const fetcher = async () => new Response("denied", { status: 401 });
    expect(createOpenAIClientSecret("bad", {
      model: "gpt-realtime-2.1-mini", maxOutputTokens: 10, contextTokenLimit: 100,
      preferences: { responseTiming: "natural", speechRate: 1 },
      realtimeTracing: true,
    }, fetcher)).rejects.toThrow("401");
  });

  test("rejects an already-expired client secret", async () => {
    const fetcher = async () => Response.json({ value: "ek_expired", expires_at: 999 });
    expect(createOpenAIClientSecret("key", {
      model: "gpt-realtime-2.1-mini", maxOutputTokens: 10, contextTokenLimit: 100,
      preferences: { responseTiming: "patient", speechRate: 0.9 },
      realtimeTracing: false,
    }, fetcher, () => 1_000_000)).rejects.toThrow("already-expired");
  });

  test("sends tracing auto when enabled and JSON null when disabled", async () => {
    const capture = async (realtimeTracing: boolean) => {
      let request: RequestInit | undefined;
      const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
        request = init;
        return new Response(JSON.stringify({ value: "ek_test", expires_at: 2_000 }), { status: 200 });
      };
      await createOpenAIClientSecret("server-key", {
        model: "gpt-realtime-2.1-mini",
        maxOutputTokens: 10,
        contextTokenLimit: 100,
        preferences: { responseTiming: "natural", speechRate: 1 },
        realtimeTracing,
      }, fetcher, () => 1_000_000);
      return JSON.parse(String(request?.body)) as { session: { tracing: unknown } };
    };

    expect((await capture(true)).session.tracing).toBe("auto");
    expect((await capture(false)).session.tracing).toBeNull();
  });

  test("advertises a closed perform_ui_actions action grammar", async () => {
    let request: RequestInit | undefined;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 2_000 }), { status: 200 });
    };
    await createOpenAIClientSecret("server-key", {
      model: "gpt-realtime-2.1-mini",
      maxOutputTokens: 10,
      contextTokenLimit: 100,
      preferences: { responseTiming: "natural", speechRate: 1 },
      realtimeTracing: true,
    }, fetcher, () => 1_000_000);
    const body = JSON.parse(String(request?.body));
    const parameters = body.session.tools[0].parameters;
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

  test("serializes routing, length, and inference policy", async () => {
    let request: RequestInit | undefined;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 2_000 }), { status: 200 });
    };
    await createOpenAIClientSecret("server-key", {
      model: "gpt-realtime-2.1-mini",
      maxOutputTokens: 10,
      contextTokenLimit: 100,
      preferences: { responseTiming: "natural", speechRate: 1 },
      realtimeTracing: true,
    }, fetcher, () => 1_000_000);
    const body = JSON.parse(String(request?.body));
    const instructions = body.session.instructions as string;

    expect(body.session.tool_choice).toBe("auto");
    expect(body.session.parallel_tool_calls).toBe(false);

    expect(instructions).toContain("one or two short sentences");
    expect(instructions).toContain("unless the user asks for detail");
    expect(instructions).toContain("perform_ui_actions");
    expect(instructions).toContain("without a spoken preamble");
    expect(instructions).toContain("Ordinary questions never call the UI tool");
    expect(instructions).toContain("Opening dashboard, library, article, or settings means navigation");
    expect(instructions).toContain("open is reserved for the library details panel");
    expect(instructions).toContain("several UI changes becomes one tool call with ordered actions");
    expect(instructions).toContain("Unqualified scroll means one downward scroll");
    expect(instructions).toContain("Explicit up, top, bottom, or down wording takes precedence");
    expect(instructions).toContain("Open article and scroll means navigate to the article");
    expect(instructions).toContain("scroll article.content down in the same call");
    expect(instructions).toContain("at most one short clarification");
    expect(instructions).toContain("Do not claim success before a successful tool result");
    expect(instructions).toContain("do not invent a retry");
  });
});
