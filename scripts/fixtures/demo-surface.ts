import type { VoiceControl } from "../../packages/surface/dist/index.js";

export const DEMO_SURFACE_NAME = "Jarvis voice demo";

export const DEMO_PAGES = ["dashboard", "library", "article", "settings"] as const;
export type DemoPage = (typeof DEMO_PAGES)[number];

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

const dashboardSearch: VoiceControl = {
  kind: "press",
  id: "dashboard.search",
  what: "Put the cursor in the dashboard search box",
};

const libraryResults: VoiceControl = {
  kind: "adjust",
  id: "library.results",
  what: "Scroll the list of library cards",
  axes: [{ id: "vertical", more: "down", less: "up" }],
};

const libraryItem: VoiceControl = {
  kind: "pick",
  id: "library.item",
  what: "Select a library card",
  items: [
    { id: "atlas", spoken: "Atlas", hint: "the first card" },
    { id: "beacon", spoken: "Beacon", hint: "the second card" },
    { id: "cinder", spoken: "Cinder", hint: "the third card" },
  ],
};

const libraryDetails: VoiceControl = {
  kind: "toggle",
  id: "library.details",
  what: "Show or hide the library details panel",
  items: [{ id: "details", spoken: "the library details panel", on: false }],
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

const settingsTheme: VoiceControl = {
  kind: "pick",
  id: "settings.theme",
  what: "Choose the color theme",
  items: [
    { id: "light", spoken: "light theme" },
    { id: "dark", spoken: "dark theme" },
    { id: "system", spoken: "follow the system theme" },
  ],
};

export const DEMO_CONTROLS: Record<DemoPage, VoiceControl[]> = {
  dashboard: [navigation, dashboardSearch],
  library: [navigation, libraryResults, libraryItem, libraryDetails],
  article: [navigation, articleContent, articleBookmark],
  settings: [navigation, settingsTheme],
};

export const DEMO_FACTS: Record<DemoPage, Record<string, string>> = {
  dashboard: {},
  library: { selected_card: "none", details_panel: "closed" },
  article: { bookmarked: "no" },
  settings: { theme: "light" },
};

export const DEMO_SCROLL_PIXELS: Record<1 | 2 | 3 | 4, number | "end"> = { 1: 120, 2: 240, 3: 480, 4: "end" };
