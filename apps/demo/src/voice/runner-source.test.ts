import { afterEach, describe, expect, it, vi } from "vitest";
import { compileInterpretRequest, decodeInterpretAnswers, type VoiceControl } from "@jarvis-viz/surface";
import { SIMULATION_TABLE, createLiveInterpret, createSimulatedInterpret } from "./runner-source.js";

const ARTICLE_CONTROLS: VoiceControl[] = [
  {
    kind: "pick",
    id: "navigation",
    what: "Go to a page of the app",
    items: [
      { id: "dashboard", spoken: "the dashboard page" },
      { id: "library", spoken: "the library page" },
      { id: "article", spoken: "the article page" },
      { id: "settings", spoken: "the settings page" },
    ],
  },
  { kind: "adjust", id: "article.content", what: "Scroll the article text", axes: [{ id: "vertical", more: "down", less: "up" }] },
  {
    kind: "toggle",
    id: "article.bookmark",
    what: "Add or remove the bookmark on this article",
    items: [{ id: "bookmark", spoken: "the bookmark on this article", on: false }],
  },
];

function compile(request: string) {
  return compileInterpretRequest({
    request,
    screen: { surface: "Jarvis voice demo", page: "article", bookmarked: "no" },
    controls: ARTICLE_CONTROLS,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSimulatedInterpret", () => {
  it("answers every compiled question", async () => {
    const request = compile("scroll the article down");
    const { answers } = await createSimulatedInterpret(SIMULATION_TABLE)(request, new AbortController().signal);
    expect(Object.keys(answers).sort()).toEqual(Object.keys(request.questions).sort());
    expect(answers["article.bookmark/polarity"]).toEqual({
      type: "choice",
      choice: "not_stated",
      probabilities: { on: 0, off: 0, not_stated: 1 },
      confidence: 1,
    });
  });

  it("puts the table overrides under the compiled question ids", async () => {
    const request = compile("scroll the article to the bottom");
    const { answers } = await createSimulatedInterpret(SIMULATION_TABLE)(request, new AbortController().signal);
    expect(answers["operates"]).toEqual({ type: "noul", noul: 0.95 });
    expect(answers["control"]).toMatchObject({ type: "choice", choice: "article.content", confidence: 1 });
    expect(answers["article.content/axis"]).toMatchObject({ type: "choice", choice: "vertical.more" });
    expect(answers["amount"]).toMatchObject({
      type: "score",
      score: 3,
      probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 },
      confidence: 1,
    });
    expect(Object.keys(answers["amount"]?.type === "score" ? answers["amount"].legend : {})).toEqual(["0", "1", "2", "3"]);
    const decoded = decodeInterpretAnswers({ answers, controls: ARTICLE_CONTROLS });
    expect(decoded).toMatchObject({
      kind: "command",
      command: { control: "article.content", kind: "adjust", axis: "vertical", direction: "more", amount: 4 },
    });
  });

  it("answers none for a sentence the table does not list", async () => {
    const request = compile("what does this demo visualize");
    const { answers } = await createSimulatedInterpret(SIMULATION_TABLE)(request, new AbortController().signal);
    expect(answers["operates"]).toEqual({ type: "noul", noul: 0.05 });
    expect(answers["control"]).toMatchObject({ choice: "none" });
    expect(decodeInterpretAnswers({ answers, controls: ARTICLE_CONTROLS })).toMatchObject({ kind: "none" });
  });

  it("reports unclear for a request that names no card", async () => {
    const controls: VoiceControl[] = [
      {
        kind: "pick",
        id: "library.item",
        what: "Select a library card",
        items: [
          { id: "atlas", spoken: "Atlas", hint: "the first card" },
          { id: "beacon", spoken: "Beacon", hint: "the second card" },
          { id: "cinder", spoken: "Cinder", hint: "the third card" },
        ],
      },
    ];
    const request = compileInterpretRequest({ request: "select a library card", screen: { surface: "Jarvis voice demo", page: "library" }, controls });
    const { answers } = await createSimulatedInterpret(SIMULATION_TABLE)(request, new AbortController().signal);
    expect(decodeInterpretAnswers({ answers, controls })).toMatchObject({ kind: "unclear" });
  });
});

describe("createLiveInterpret", () => {
  it("posts the compiled request to /interpret on the session origin", async () => {
    const fetchMock = vi.fn(async () => Response.json({ model: "jev-1.13.0", answers: { operates: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 42 } }));
    vi.stubGlobal("fetch", fetchMock);
    const request = compile("scroll the article down");
    const controller = new AbortController();
    const answers = await createLiveInterpret("http://localhost:3010/session")(request, controller.signal);
    expect(answers).toEqual({ answers: { operates: { type: "noul", noul: 0.9 } }, model: "jev-1.13.0", usage: { input_tokens: 42 } });
    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(call[0])).toBe("http://localhost:3010/interpret");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers).toEqual({ "Content-Type": "application/json" });
    expect(call[1].signal).toBe(controller.signal);
    expect(JSON.parse(String(call[1].body))).toEqual(request);
  });

  it("throws with the status when the route does not answer 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Interpretation is not configured" }), { status: 503 })));
    await expect(createLiveInterpret("http://localhost:3010/session")(compile("scroll the article down"), new AbortController().signal))
      .rejects.toThrow("503");
  });

  it("throws with the status when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(createLiveInterpret("http://localhost:3010/session")(compile("scroll the article down"), new AbortController().signal))
      .rejects.toThrow("200");
  });
});
