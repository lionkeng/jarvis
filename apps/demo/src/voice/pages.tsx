import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { VoiceCapability, VoiceOutcome, VoiceRegistry } from "@jarvis-viz/surface";
import { useVoiceCapability } from "@jarvis-viz/surface/react";
import type { RouteId } from "./hash-router.js";

export type LibraryItem = "atlas" | "beacon" | "cinder";
export type ThemeChoice = "light" | "dark" | "system";

export interface VoicePageModel {
  libraryItem: LibraryItem | undefined;
  detailsOpen: boolean;
  theme: ThemeChoice;
  bookmarked: boolean;
  setLibraryItem: (value: LibraryItem) => void;
  setDetailsOpen: (open: boolean) => void;
  setTheme: (theme: ThemeChoice) => void;
  setBookmarked: (value: boolean) => void;
}

/** Amount 4 scrolls the region to its end. The other levels move a fixed number of pixels. */
export const DEMO_SCROLL_PIXELS = { 1: 120, 2: 240, 3: 480 } as const;

const ROUTE_ITEMS: ReadonlyArray<{ id: RouteId; spoken: string }> = [
  { id: "dashboard", spoken: "the dashboard page" },
  { id: "library", spoken: "the library page" },
  { id: "article", spoken: "the article page" },
  { id: "settings", spoken: "the settings page" },
];

const LIBRARY_ITEMS: ReadonlyArray<{ id: LibraryItem; title: string; hint: string; body: string }> = [
  { id: "atlas", title: "Atlas", hint: "the first card", body: "A north-facing chart of the demo's voice routes and registry ids." },
  { id: "beacon", title: "Beacon", hint: "the second card", body: "A short primer on turning a spoken request into one typed command." },
  { id: "cinder", title: "Cinder", hint: "the third card", body: "Notes on interruption, queue bounds, and cancelled follow-up speech." },
];

const THEME_ITEMS: ReadonlyArray<{ id: ThemeChoice; spoken: string }> = [
  { id: "light", spoken: "light theme" },
  { id: "dark", spoken: "dark theme" },
  { id: "system", spoken: "follow the system theme" },
];

const ARTICLE_PARAGRAPHS = [
  "This article is long enough to scroll. Voice can jump to the top or bottom, or move a bounded step.",
  "The runner waits for the registry to settle before it describes the screen, so a compound navigate-then-scroll request does not race the route render.",
  "Pointer and keyboard controls call the same React setters. The bookmark button does not click itself when voice sets it.",
  "Reduced motion replaces smooth scrolling with an immediate jump.",
  "The remaining paragraphs exist so the named region actually overflows.",
  "Keep going. The bottom of this region is the target for the compound demo script.",
  "Still more text, because a short article would make scroll-to-bottom invisible.",
  "End of the named article content region.",
];

const UNAVAILABLE: VoiceOutcome = { status: "unavailable", say: "That is not available right now." };

function scrollRegion(element: HTMLElement, direction: "more" | "less", amount: 1 | 2 | 3 | 4): VoiceOutcome {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  if (amount === 4) {
    element.scrollTo({ top: direction === "more" ? element.scrollHeight : 0, behavior });
    return { status: "done", say: direction === "more" ? "Scrolled to the bottom." : "Scrolled to the top." };
  }
  const pixels = DEMO_SCROLL_PIXELS[amount];
  element.scrollBy({ top: direction === "more" ? pixels : -pixels, behavior });
  return { status: "done", say: direction === "more" ? "Scrolled down." : "Scrolled up." };
}

function scrollCapability(id: string, what: string, region: { current: HTMLElement | null }): VoiceCapability {
  return {
    describe: () => ({
      control: { kind: "adjust", id, what, axes: [{ id: "vertical", more: "down", less: "up" }] },
    }),
    execute: async (command) => {
      const element = region.current;
      if (command.kind !== "adjust" || !element) return UNAVAILABLE;
      return scrollRegion(element, command.direction, command.amount);
    },
  };
}

export function NavigationCapability({ registry, route, navigate }: {
  registry: VoiceRegistry;
  route: RouteId;
  navigate: (route: RouteId) => Promise<void>;
}): null {
  useVoiceCapability(registry, {
    describe: () => ({
      control: {
        kind: "pick",
        id: "navigation",
        what: "Go to a page of the app",
        items: ROUTE_ITEMS.map((item) => ({ id: item.id, spoken: item.spoken })),
      },
      facts: { page: route },
    }),
    execute: async (command) => {
      const target = ROUTE_ITEMS.find((item) => command.kind === "pick" && item.id === command.item);
      if (command.kind !== "pick" || !target) return UNAVAILABLE;
      await navigate(target.id);
      return { status: "done", say: `Opened the ${target.id} page.` };
    },
  });
  return null;
}

export function DashboardPage({ registry }: { registry: VoiceRegistry }): ReactNode {
  const searchRef = useRef<HTMLInputElement>(null);
  useVoiceCapability(registry, {
    describe: () => ({
      control: { kind: "press", id: "dashboard.search", what: "Put the cursor in the dashboard search box" },
    }),
    execute: async () => {
      const search = searchRef.current;
      if (!search) return UNAVAILABLE;
      search.focus();
      return { status: "done", say: "Focused search." };
    },
  });
  return (
    <section className="page" aria-labelledby="dashboard-title">
      <h2 id="dashboard-title">Dashboard <span className="voice-id">dashboard.search</span></h2>
      <label>
        Search
        <input ref={searchRef} className="search" type="search" name="dashboard-search" data-voice-id="dashboard.search" />
      </label>
      <p>
        <button type="button" onClick={() => searchRef.current?.focus()}>
          Focus search
        </button>
      </p>
    </section>
  );
}

export function LibraryPage({ registry, model }: { registry: VoiceRegistry; model: VoicePageModel }): ReactNode {
  const resultsRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useVoiceCapability(registry, scrollCapability("library.results", "Scroll the list of library cards", resultsRef));
  useVoiceCapability(registry, {
    describe: () => ({
      control: {
        kind: "pick",
        id: "library.item",
        what: "Select a library card",
        items: LIBRARY_ITEMS.map((item) => ({ id: item.id, spoken: item.title, hint: item.hint })),
      },
      facts: { selected_card: model.libraryItem ?? "none" },
    }),
    execute: async (command) => {
      const card = LIBRARY_ITEMS.find((item) => command.kind === "pick" && item.id === command.item);
      if (command.kind !== "pick" || !card) return UNAVAILABLE;
      model.setLibraryItem(card.id);
      return { status: "done", say: `Selected ${card.title}.` };
    },
  });
  useVoiceCapability(registry, {
    describe: () => ({
      control: {
        kind: "toggle",
        id: "library.details",
        what: "Show or hide the library details panel",
        items: [{ id: "details", spoken: "the library details panel", on: model.detailsOpen }],
      },
      facts: { details_panel: model.detailsOpen ? "open" : "closed" },
    }),
    execute: async (command) => {
      if (command.kind !== "toggle") return UNAVAILABLE;
      const wanted = command.to === "on";
      if (wanted === model.detailsOpen) {
        return { status: "no_effect", say: wanted ? "The details panel is already open." : "The details panel is already closed." };
      }
      model.setDetailsOpen(wanted);
      if (!wanted) openRef.current?.focus();
      return { status: "done", say: wanted ? "Opened the details panel." : "Closed the details panel." };
    },
  });
  useLayoutEffect(() => {
    if (model.detailsOpen) closeRef.current?.focus();
  }, [model.detailsOpen]);
  const selected = LIBRARY_ITEMS.find((item) => item.id === model.libraryItem);
  return (
    <section className="page" aria-labelledby="library-title">
      <h2 id="library-title">Library <span className="voice-id">library.item</span></h2>
      <div ref={resultsRef} className="scroll-region cards" data-voice-id="library.results" tabIndex={0} aria-label="Library results">
        {LIBRARY_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={model.libraryItem === item.id}
            data-voice-id="library.item"
            onClick={() => model.setLibraryItem(item.id)}
          >
            <strong>{item.title}</strong>
            <div>{item.body}</div>
          </button>
        ))}
      </div>
      <p>
        <button ref={openRef} type="button" onClick={() => model.setDetailsOpen(true)}>
          Open details
        </button>
      </p>
      {model.detailsOpen ? (
        <aside className="drawer" role="dialog" aria-labelledby="details-title" data-voice-id="library.details">
          <h3 id="details-title">{selected?.title ?? "Library details"}</h3>
          <p>{selected?.body ?? "Select Atlas, Beacon, or Cinder first."}</p>
          <button ref={closeRef} type="button" onClick={() => model.setDetailsOpen(false)}>
            Close details
          </button>
        </aside>
      ) : null}
    </section>
  );
}

export function ArticlePage({ registry, model }: { registry: VoiceRegistry; model: VoicePageModel }): ReactNode {
  const contentRef = useRef<HTMLDivElement>(null);
  useVoiceCapability(registry, scrollCapability("article.content", "Scroll the article text", contentRef));
  useVoiceCapability(registry, {
    describe: () => ({
      control: {
        kind: "toggle",
        id: "article.bookmark",
        what: "Add or remove the bookmark on this article",
        items: [{ id: "bookmark", spoken: "the bookmark on this article", on: model.bookmarked }],
      },
      facts: { bookmarked: model.bookmarked ? "yes" : "no" },
    }),
    execute: async (command) => {
      if (command.kind !== "toggle") return UNAVAILABLE;
      const wanted = command.to === "on";
      if (wanted === model.bookmarked) {
        return { status: "no_effect", say: wanted ? "The article is already bookmarked." : "The article is not bookmarked." };
      }
      model.setBookmarked(wanted);
      return { status: "done", say: wanted ? "Bookmarked the article." : "Removed the bookmark." };
    },
  });
  return (
    <section className="page" aria-labelledby="article-title">
      <h2 id="article-title">Article <span className="voice-id">article.bookmark</span></h2>
      <button
        type="button"
        aria-pressed={model.bookmarked}
        data-voice-id="article.bookmark"
        onClick={() => model.setBookmarked(!model.bookmarked)}
      >
        {model.bookmarked ? "Bookmarked" : "Bookmark"}
      </button>
      <div ref={contentRef} className="article-body scroll-region" data-voice-id="article.content" tabIndex={0} aria-label="Article content">
        {ARTICLE_PARAGRAPHS.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </div>
    </section>
  );
}

export function SettingsPage({ registry, model }: { registry: VoiceRegistry; model: VoicePageModel }): ReactNode {
  useVoiceCapability(registry, {
    describe: () => ({
      control: {
        kind: "pick",
        id: "settings.theme",
        what: "Choose the color theme",
        items: THEME_ITEMS.map((item) => ({ id: item.id, spoken: item.spoken })),
      },
      facts: { theme: model.theme },
    }),
    execute: async (command) => {
      const choice = THEME_ITEMS.find((item) => command.kind === "pick" && item.id === command.item);
      if (command.kind !== "pick" || !choice) return UNAVAILABLE;
      model.setTheme(choice.id);
      return { status: "done", say: `Set the ${choice.id} theme.` };
    },
  });
  return (
    <section className="page" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings <span className="voice-id">settings.theme</span></h2>
      <div className="toolbar" role="group" aria-label="Theme">
        {THEME_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={model.theme === item.id}
            onClick={() => model.setTheme(item.id)}
          >
            {item.id}
          </button>
        ))}
      </div>
    </section>
  );
}

export function RoutePage({ route, registry, model }: {
  route: RouteId;
  registry: VoiceRegistry;
  model: VoicePageModel;
}): ReactNode {
  switch (route) {
    case "dashboard":
      return <DashboardPage registry={registry} />;
    case "library":
      return <LibraryPage registry={registry} model={model} />;
    case "article":
      return <ArticlePage registry={registry} model={model} />;
    case "settings":
      return <SettingsPage registry={registry} model={model} />;
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}
