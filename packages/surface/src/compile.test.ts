import { describe, expect, it } from "vitest";
import { MAX_CONTROL_OPTIONS, compileInterpretRequest } from "./compile.js";
import type { VoiceControl } from "./types.js";

const navigation: VoiceControl = {
  kind: "pick",
  id: "navigation",
  what: "Go to a page of the app",
  items: [
    { id: "dashboard", spoken: "the dashboard page" },
    { id: "library", spoken: "the library page" },
    { id: "article", spoken: "the article page" },
    { id: "settings", spoken: "the settings page" },
  ],
};

const articleContent: VoiceControl = {
  kind: "adjust",
  id: "article.content",
  what: "Scroll the article text",
  axes: [{ id: "vertical", more: "down", less: "up" }],
};

const articleBookmark: VoiceControl = {
  kind: "toggle",
  id: "article.bookmark",
  what: "Add or remove the bookmark on this article",
  items: [{ id: "bookmark", spoken: "the bookmark on this article", on: false }],
};

const dashboardSearch: VoiceControl = {
  kind: "press",
  id: "dashboard.search",
  what: "Put the cursor in the dashboard search box",
};

// Copied from the plan's "Example compiled request" block.
const planExample = `
{
  "state": {
    "request": "scroll the article to the bottom",
    "screen": { "surface": "Jarvis voice demo", "page": "article", "bookmarked": "no" }
  },
  "questions": {
    "operates": { "type": "noul", "instructions": "Does \`request\` ask to change, open, close, select, move, or operate something on the screen described by \`screen\`, rather than ask a question or make conversation?" },
    "control": {
      "type": "choice",
      "instructions": "Which control on \`screen\` does \`request\` ask to operate?",
      "criteria": {
        "navigation": { "what": "Go to a page of the app", "options": ["the dashboard page", "the library page", "the article page", "the settings page"] },
        "article.content": { "what": "Scroll the article text", "options": ["down", "up"] },
        "article.bookmark": { "what": "Add or remove the bookmark on this article", "options": ["the bookmark on this article"] },
        "none": "The request does not operate any control on this screen"
      }
    },
    "navigation/item": {
      "type": "choice",
      "instructions": "Assume \`request\` operates Go to a page of the app. Which one does it name?",
      "criteria": { "dashboard": "the dashboard page", "library": "the library page", "article": "the article page", "settings": "the settings page", "not_stated": "No listed option fits" }
    },
    "article.bookmark/polarity": {
      "type": "choice",
      "instructions": "Assume \`request\` operates Add or remove the bookmark on this article. Does it ask to turn it on or off?",
      "criteria": { "on": "Turn on, open, show, enable, add, or start", "off": "Turn off, close, hide, disable, remove, or stop", "not_stated": "The request does not say which, such as toggle, switch, or flip" }
    },
    "article.content/axis": {
      "type": "choice",
      "instructions": "Assume \`request\` moves Scroll the article text. Which way?",
      "criteria": { "vertical.more": "down", "vertical.less": "up", "not_stated": null }
    },
    "amount": {
      "type": "score",
      "instructions": "How large a change does \`request\` ask for?",
      "criteria": [
        "The smallest step, with words such as a touch, a bit, a little, or slightly",
        "One ordinary step, with no size words",
        "A large step, with words such as a lot, much, or way",
        "The whole way, with words such as all the way, to the top, to the bottom, to the end, or fully"
      ]
    }
  }
}
`;

describe("compileInterpretRequest", () => {
  it("reproduces the planned request for the article page down to key order", () => {
    const compiled = compileInterpretRequest({
      request: "scroll the article to the bottom",
      screen: { surface: "Jarvis voice demo", page: "article", bookmarked: "no" },
      controls: [navigation, articleContent, articleBookmark],
    });
    expect(JSON.stringify(compiled)).toBe(JSON.stringify(JSON.parse(planExample)));
  });

  it("asks operates and control first and in that order", () => {
    const compiled = compileInterpretRequest({
      request: "open the search box",
      screen: { surface: "Jarvis voice demo", page: "dashboard" },
      controls: [dashboardSearch],
    });
    expect(Object.keys(compiled.questions)).toEqual(["operates", "control"]);
  });

  it("describes a press control by what alone", () => {
    const compiled = compileInterpretRequest({
      request: "focus search",
      screen: { page: "dashboard" },
      controls: [dashboardSearch],
    });
    const control = compiled.questions["control"];
    expect(control?.type === "choice" ? control.criteria["dashboard.search"] : undefined).toEqual({
      what: "Put the cursor in the dashboard search box",
    });
  });

  it("gives a control with one item no item question", () => {
    const compiled = compileInterpretRequest({
      request: "bookmark this",
      screen: { page: "article" },
      controls: [articleBookmark],
    });
    expect(Object.keys(compiled.questions)).toEqual(["operates", "control", "article.bookmark/polarity"]);
  });

  it("asks an item question for a pick control with two or more items", () => {
    const compiled = compileInterpretRequest({
      request: "go to the library",
      screen: { page: "article" },
      controls: [navigation],
    });
    const item = compiled.questions["navigation/item"];
    expect(item?.type === "choice" ? Object.keys(item.criteria) : []).toEqual([
      "dashboard",
      "library",
      "article",
      "settings",
      "not_stated",
    ]);
  });

  it("carries an item hint beside its spoken name", () => {
    const compiled = compileInterpretRequest({
      request: "select the third card",
      screen: { page: "library" },
      controls: [
        {
          kind: "pick",
          id: "library.item",
          what: "Select a library card",
          items: [
            { id: "atlas", spoken: "Atlas", hint: "the first card" },
            { id: "beacon", spoken: "Beacon", hint: "the second card" },
          ],
        },
      ],
    });
    const item = compiled.questions["library.item/item"];
    expect(item?.type === "choice" ? item.criteria["atlas"] : undefined).toEqual({
      spoken: "Atlas",
      hint: "the first card",
    });
  });

  it("adds the amount question only when an adjust control is on screen", () => {
    const withoutAdjust = compileInterpretRequest({
      request: "go to the library",
      screen: { page: "dashboard" },
      controls: [navigation, dashboardSearch],
    });
    const withAdjust = compileInterpretRequest({
      request: "scroll down",
      screen: { page: "article" },
      controls: [navigation, articleContent],
    });
    expect(Object.keys(withoutAdjust.questions)).not.toContain("amount");
    expect(Object.keys(withAdjust.questions).at(-1)).toBe("amount");
  });

  it("asks one amount question for two adjust controls", () => {
    const compiled = compileInterpretRequest({
      request: "scroll down",
      screen: { page: "library" },
      controls: [
        articleContent,
        { kind: "adjust", id: "library.results", what: "Scroll the list of library cards", axes: [{ id: "vertical", more: "down", less: "up" }] },
      ],
    });
    expect(Object.keys(compiled.questions)).toEqual([
      "operates",
      "control",
      "article.content/axis",
      "library.results/axis",
      "amount",
    ]);
  });

  it("lists every axis word in one axis question and ends with not_stated", () => {
    const compiled = compileInterpretRequest({
      request: "zoom in a lot",
      screen: { page: "plan" },
      controls: [
        {
          kind: "adjust",
          id: "view",
          what: "Zoom the plan",
          axes: [
            { id: "zoom", more: "in", less: "out" },
            { id: "tilt", more: "up", less: "down" },
          ],
        },
      ],
    });
    const axis = compiled.questions["view/axis"];
    expect(axis?.type === "choice" ? axis.criteria : {}).toEqual({
      "zoom.more": "in",
      "zoom.less": "out",
      "tilt.more": "up",
      "tilt.less": "down",
      not_stated: null,
    });
  });

  it("lists at most sixteen spoken options for one control", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, spoken: `option ${index}` }));
    const compiled = compileInterpretRequest({
      request: "pick option 19",
      screen: { page: "library" },
      controls: [{ kind: "pick", id: "big", what: "Pick one", items }],
    });
    const control = compiled.questions["control"];
    const criterion = control?.type === "choice" ? control.criteria["big"] : undefined;
    const options = criterion !== null && typeof criterion === "object" && "options" in criterion ? criterion.options : [];
    expect(options).toHaveLength(MAX_CONTROL_OPTIONS);
    const item = compiled.questions["big/item"];
    expect(item?.type === "choice" ? Object.keys(item.criteria) : []).toHaveLength(21);
  });

  it("carries the request and screen through as the state", () => {
    const compiled = compileInterpretRequest({
      request: "scroll down a bit",
      screen: { surface: "Jarvis voice demo", page: "article", bookmarked: "yes" },
      controls: [articleContent],
    });
    expect(compiled.state).toEqual({
      request: "scroll down a bit",
      screen: { surface: "Jarvis voice demo", page: "article", bookmarked: "yes" },
    });
  });
});
