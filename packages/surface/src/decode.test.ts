import { describe, expect, it } from "vitest";
import { AMOUNT_LEVELS } from "./compile.js";
import { DEFAULT_BARS, decodeInterpretAnswers } from "./decode.js";
import type { ChoiceAnswer, InterpretAnswerMap, NoulAnswer, ScoreAnswer, VoiceControl } from "./types.js";

const navigation: VoiceControl = {
  kind: "pick",
  id: "navigation",
  what: "Go to a page of the app",
  items: [
    { id: "dashboard", spoken: "the dashboard page" },
    { id: "library", spoken: "the library page" },
    { id: "article", spoken: "the article page" },
  ],
};

const search: VoiceControl = {
  kind: "press",
  id: "dashboard.search",
  what: "Put the cursor in the dashboard search box",
};

const bookmark: VoiceControl = {
  kind: "toggle",
  id: "article.bookmark",
  what: "Add or remove the bookmark on this article",
  items: [{ id: "bookmark", spoken: "the bookmark on this article", on: false }],
};

const content: VoiceControl = {
  kind: "adjust",
  id: "article.content",
  what: "Scroll the article text",
  axes: [{ id: "vertical", more: "down", less: "up" }],
};

const reset: VoiceControl = { kind: "press", id: "plan.reset", what: "Clear the plan", risk: "high" };

const noul = (value: number): NoulAnswer => ({ type: "noul", noul: value });

function choice(value: string, confidence = 1, probabilities?: Record<string, number>): ChoiceAnswer {
  return { type: "choice", choice: value, probabilities: probabilities ?? { [value]: 1 }, confidence };
}

function score(value: number, confidence = 1): ScoreAnswer {
  return {
    type: "score",
    score: value,
    legend: Object.fromEntries(AMOUNT_LEVELS.map((level, index) => [`${index}`, level])),
    probabilities: Object.fromEntries(AMOUNT_LEVELS.map((_level, index) => [`${index}`, 0.25])),
    confidence,
  };
}

const controls = [navigation, search, bookmark, content, reset];

function decode(answers: InterpretAnswerMap) {
  return decodeInterpretAnswers({ answers, controls, bars: DEFAULT_BARS });
}

describe("decodeInterpretAnswers", () => {
  it("returns none when operates sits below its bar", () => {
    expect(decode({ operates: noul(0.2), control: choice("navigation") })).toEqual({
      kind: "none",
      operates: 0.2,
      confidence: 0.8,
    });
  });

  it("returns none when the route picks no control", () => {
    expect(decode({ operates: noul(0.9), control: choice("none", 0.7) })).toEqual({
      kind: "none",
      operates: 0.9,
      confidence: 0.7,
    });
  });

  it("completes a press command from the route alone", () => {
    const result = decode({ operates: noul(0.9), control: choice("dashboard.search", 0.8) });
    expect(result).toEqual({
      kind: "command",
      command: { control: "dashboard.search", kind: "press" },
      control: search,
      confidence: 0.8,
    });
  });

  it("reads the item for a pick command", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("navigation", 0.9),
      "navigation/item": choice("library", 0.8),
    });
    expect(result).toMatchObject({ kind: "command", command: { control: "navigation", kind: "pick", item: "library" } });
  });

  it("takes the only item of a single item control with no item answer", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("article.bookmark", 0.9),
      "article.bookmark/polarity": choice("on", 0.9),
    });
    expect(result).toMatchObject({
      kind: "command",
      command: { control: "article.bookmark", kind: "toggle", item: "bookmark", to: "on" },
    });
  });

  it("flips an unstated polarity away from the item's current state", () => {
    const off = decode({
      operates: noul(0.9),
      control: choice("article.bookmark", 0.9),
      "article.bookmark/polarity": choice("not_stated", 0.9),
    });
    expect(off).toMatchObject({ command: { to: "on" } });
    const on = decodeInterpretAnswers({
      answers: {
        operates: noul(0.9),
        control: choice("article.bookmark", 0.9),
        "article.bookmark/polarity": choice("not_stated", 0.9),
      },
      controls: [{ ...bookmark, items: [{ id: "bookmark", spoken: "the bookmark on this article", on: true }] }],
    });
    expect(on).toMatchObject({ command: { to: "off" } });
  });

  it("splits the axis answer and reads the amount for an adjust command", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("article.content", 0.9),
      "article.content/axis": choice("vertical.more", 0.9),
      amount: score(3),
    });
    expect(result).toMatchObject({
      kind: "command",
      command: { control: "article.content", kind: "adjust", axis: "vertical", direction: "more", amount: 4 },
    });
  });

  it("rounds and clamps the score into the four amount levels", () => {
    const amounts = [-2, 0, 0.4, 1.5, 2.4, 3, 9].map((value) => {
      const result = decode({
        operates: noul(0.9),
        control: choice("article.content", 0.9),
        "article.content/axis": choice("vertical.less", 0.9),
        amount: score(value),
      });
      return result.kind === "command" && result.command.kind === "adjust" ? result.command.amount : undefined;
    });
    expect(amounts).toEqual([1, 1, 1, 3, 3, 4, 4]);
  });

  it("returns unclear with the two likeliest item names when the item is not stated", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("navigation", 0.9),
      "navigation/item": choice("not_stated", 0.6, { dashboard: 0.1, library: 0.3, article: 0.25, not_stated: 0.35 }),
    });
    expect(result).toEqual({ kind: "unclear", candidates: ["the library page", "the article page"], confidence: 0.6 });
  });

  it("returns unclear with the axis words when the axis is not stated", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("article.content", 0.9),
      "article.content/axis": choice("not_stated", 0.7, { "vertical.more": 0.2, "vertical.less": 0.3, not_stated: 0.5 }),
      amount: score(1),
    });
    expect(result).toEqual({ kind: "unclear", candidates: ["up", "down"], confidence: 0.7 });
  });

  it("takes the lowest confidence of every answer it consumed", () => {
    const result = decode({
      operates: noul(0.99),
      control: choice("article.content", 0.9),
      "article.content/axis": choice("vertical.more", 0.62),
      amount: score(1, 0.71),
    });
    expect(result).toMatchObject({ kind: "command", confidence: 0.62 });
  });

  it("returns unclear with the two likeliest control names below the ordinary bar", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("navigation", 0.44, { navigation: 0.44, "article.content": 0.4, "dashboard.search": 0.06, none: 0.1 }),
      "navigation/item": choice("library", 0.9),
    });
    expect(result).toEqual({
      kind: "unclear",
      candidates: ["Go to a page of the app", "Scroll the article text"],
      confidence: 0.44,
    });
  });

  it("holds a high risk control to the high bar", () => {
    const answers = { operates: noul(0.95), control: choice("plan.reset", 0.8) };
    expect(decode(answers)).toMatchObject({ kind: "unclear", confidence: 0.8 });
    expect(decode({ operates: noul(0.95), control: choice("plan.reset", 0.9) })).toMatchObject({ kind: "command" });
  });

  it("reports a missing answer as malformed", () => {
    expect(decode({ control: choice("navigation") })).toMatchObject({ kind: "malformed" });
    expect(decode({ operates: noul(0.9) })).toMatchObject({ kind: "malformed" });
    expect(decode({ operates: noul(0.9), control: choice("navigation", 0.9) })).toMatchObject({ kind: "malformed" });
    expect(
      decode({
        operates: noul(0.9),
        control: choice("article.content", 0.9),
        "article.content/axis": choice("vertical.more", 0.9),
      }),
    ).toMatchObject({ kind: "malformed" });
  });

  it("reports a mistyped answer as malformed", () => {
    const answers = { operates: choice("yes"), control: choice("navigation") } as unknown as InterpretAnswerMap;
    expect(decode(answers)).toMatchObject({ kind: "malformed" });
  });

  it("reports an answer naming something off screen as malformed", () => {
    expect(decode({ operates: noul(0.9), control: choice("library.item", 0.9) })).toMatchObject({ kind: "malformed" });
    expect(
      decode({
        operates: noul(0.9),
        control: choice("navigation", 0.9),
        "navigation/item": choice("settings", 0.9),
      }),
    ).toMatchObject({ kind: "malformed" });
  });

  it("asks about the polarity when the polarity answer was the weakest", () => {
    const result = decode({
      operates: noul(0.95),
      control: choice("article.bookmark", 1),
      "article.bookmark/polarity": choice("off", 0.36, { on: 0.3, off: 0.36, not_stated: 0.34 }),
    });
    expect(result).toEqual({ kind: "unclear", candidates: ["off", "on"], confidence: 0.36 });
  });

  it("asks about the item when the item answer was the weakest", () => {
    const result = decode({
      operates: noul(0.95),
      control: choice("navigation", 0.9),
      "navigation/item": choice("dashboard", 0.4, { dashboard: 0.4, library: 0.35, article: 0.05 }),
    });
    expect(result).toEqual({
      kind: "unclear",
      candidates: ["the dashboard page", "the library page"],
      confidence: 0.4,
    });
  });

  it("asks about the direction when the axis answer was the weakest", () => {
    const result = decode({
      operates: noul(0.95),
      control: choice("article.content", 0.9),
      "article.content/axis": choice("vertical.more", 0.3, { "vertical.more": 0.5, "vertical.less": 0.4, not_stated: 0.1 }),
      amount: score(1),
    });
    expect(result).toEqual({ kind: "unclear", candidates: ["down", "up"], confidence: 0.3 });
  });

  it("asks about the control when the amount answer was the weakest", () => {
    const result = decode({
      operates: noul(0.95),
      control: choice("article.content", 0.9, { "article.content": 0.9, navigation: 0.08, none: 0.02 }),
      "article.content/axis": choice("vertical.more", 0.9),
      amount: score(1, 0.2),
    });
    expect(result).toEqual({
      kind: "unclear",
      candidates: ["Scroll the article text", "Go to a page of the app"],
      confidence: 0.2,
    });
  });

  it("reads the amount from a score answer in the documented wire shape", () => {
    const wire = JSON.parse(
      '{"type":"score","score":1.43,"confidence":0.35,"legend":{"0":"a","1":"b","2":"c"},"probabilities":{"0":0.0,"1":0.57,"2":0.43}}',
    ) as ScoreAnswer;
    const result = decodeInterpretAnswers({
      answers: {
        operates: noul(0.9),
        control: choice("article.content", 0.9),
        "article.content/axis": choice("vertical.more", 0.9),
        amount: wire,
      },
      controls,
      bars: { operates: 0.5, ordinary: 0.3, high: 0.85 },
    });
    expect(result).toMatchObject({ kind: "command", command: { amount: 2 }, confidence: 0.35 });
  });

  it("decodes a score answer that carries no legend or probabilities", () => {
    const result = decode({
      operates: noul(0.9),
      control: choice("article.content", 0.9),
      "article.content/axis": choice("vertical.more", 0.9),
      amount: { type: "score", score: 2, confidence: 0.9 } as ScoreAnswer,
    });
    expect(result).toMatchObject({ kind: "command", command: { amount: 3 } });
  });

  it("uses the default bars when none are given", () => {
    const result = decodeInterpretAnswers({
      answers: { operates: noul(0.6), control: choice("dashboard.search", 0.51) },
      controls,
    });
    expect(result).toMatchObject({ kind: "command" });
    expect(DEFAULT_BARS).toEqual({ operates: 0.5, ordinary: 0.5, high: 0.85 });
  });
});
