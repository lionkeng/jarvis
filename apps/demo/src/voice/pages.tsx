import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { ActorRefFrom } from "xstate";
import { NAVIGATION_CAPABILITY_ID, useUiCapability, type UiCapabilityRegistry } from "./capability-registry.js";
import type { RouteId, UiCommand } from "./interaction-contract.js";
import { interactionMachine } from "./interaction-machine.js";

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

export type InteractionActor = ActorRefFrom<typeof interactionMachine>;

const NAV_ACTIONS = ["navigate"] as const;
const DETAILS_ACTIONS = ["open", "close"] as const;
const ITEM_ACTIONS = ["select"] as const;
const THEME_ACTIONS = ["select"] as const;
const SCROLL_ACTIONS = ["scroll"] as const;
const FOCUS_ACTIONS = ["focus"] as const;
const ACTIVATE_ACTIONS = ["activate"] as const;

const LIBRARY_ITEMS: ReadonlyArray<{ id: LibraryItem; title: string; body: string }> = [
  { id: "atlas", title: "Atlas", body: "A north-facing chart of the demo's voice routes and registry ids." },
  { id: "beacon", title: "Beacon", body: "A short primer on turning spoken UI requests into perform_ui_actions." },
  { id: "cinder", title: "Cinder", body: "Notes on interruption, queue bounds, and cancelled follow-up speech." },
];

const ARTICLE_PARAGRAPHS = [
  "This article is long enough to scroll. Voice can jump to the top or bottom, or move a bounded step.",
  "The interaction actor waits for this region to register before scrolling, so a compound navigate-then-scroll request does not race the route render.",
  "Pointer and keyboard controls send the same typed commands. The bookmark button does not click itself when voice activates it.",
  "Reduced motion replaces smooth scrolling with an immediate jump.",
  "The remaining paragraphs exist so the named region actually overflows.",
  "Keep going. The bottom of this region is the target for the compound demo script.",
  "Still more text, because a short article would make scroll-to-bottom invisible.",
  "End of the named article content region.",
];

export function scrollRegion(element: HTMLElement, direction: "up" | "down" | "top" | "bottom"): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  switch (direction) {
    case "top":
      element.scrollTo({ top: 0, behavior });
      return;
    case "bottom":
      element.scrollTo({ top: element.scrollHeight, behavior });
      return;
    case "up":
      element.scrollBy({ top: -240, behavior });
      return;
    case "down":
      element.scrollBy({ top: 240, behavior });
      return;
    default: {
      const _exhaustive: never = direction;
      return _exhaustive;
    }
  }
}

export function sendTyped(actor: InteractionActor, commands: UiCommand[], source: "pointer" | "keyboard" = "pointer"): void {
  actor.send({ type: "TYPED_REQUEST", source, commands });
}

export function NavigationCapability({ registry, routerNavigate }: { registry: UiCapabilityRegistry; routerNavigate: (route: RouteId) => Promise<void> }): null {
  useUiCapability(registry, NAVIGATION_CAPABILITY_ID, {
    supportedActions: NAV_ACTIONS,
    execute: async (command) => {
      if (command.type !== "navigate") return;
      await routerNavigate(command.route);
    },
  });
  return null;
}

export function DashboardPage({ registry, actor }: { registry: UiCapabilityRegistry; actor: InteractionActor }): ReactNode {
  const searchRef = useRef<HTMLInputElement>(null);
  useUiCapability(registry, "dashboard.search", {
    supportedActions: FOCUS_ACTIONS,
    execute: async (command) => {
      if (command.type !== "focus") return;
      searchRef.current?.focus();
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
        <button type="button" onClick={() => sendTyped(actor, [{ type: "focus", target: "dashboard.search" }])}>
          Focus search
        </button>
      </p>
    </section>
  );
}

export function LibraryPage({ registry, actor, model }: { registry: UiCapabilityRegistry; actor: InteractionActor; model: VoicePageModel }): ReactNode {
  const resultsRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useUiCapability(registry, "library.results", {
    supportedActions: SCROLL_ACTIONS,
    execute: async (command) => {
      if (command.type !== "scroll" || !resultsRef.current) return;
      scrollRegion(resultsRef.current, command.direction);
    },
  });
  useUiCapability(registry, "library.item", {
    supportedActions: ITEM_ACTIONS,
    execute: async (command) => {
      if (command.type !== "select" || command.target !== "library.item") return;
      model.setLibraryItem(command.value);
    },
  });
  useUiCapability(registry, "library.details", {
    supportedActions: DETAILS_ACTIONS,
    execute: async (command) => {
      if (command.type === "open") {
        model.setDetailsOpen(true);
        return;
      }
      if (command.type === "close") {
        model.setDetailsOpen(false);
        openRef.current?.focus();
      }
    },
  });
  useLayoutEffect(() => {
    if (model.detailsOpen) closeRef.current?.focus();
  }, [model.detailsOpen]);
  const selected = LIBRARY_ITEMS.find((item) => item.id === model.libraryItem);
  return (
    <section className="page" aria-labelledby="library-title">
      <h2 id="library-title">Library</h2>
      <div ref={resultsRef} className="scroll-region cards" data-voice-id="library.results" tabIndex={0} aria-label="Library results">
        {LIBRARY_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={model.libraryItem === item.id}
            data-voice-id="library.item"
            onClick={() => sendTyped(actor, [{ type: "select", target: "library.item", value: item.id }])}
          >
            <strong>{item.title}</strong>
            <div>{item.body}</div>
          </button>
        ))}
      </div>
      <p>
        <button ref={openRef} type="button" onClick={() => sendTyped(actor, [{ type: "open", target: "library.details" }])}>
          Open details
        </button>
      </p>
      {model.detailsOpen ? (
        <aside className="drawer" role="dialog" aria-labelledby="details-title" data-voice-id="library.details">
          <h3 id="details-title">{selected?.title ?? "Library details"}</h3>
          <p>{selected?.body ?? "Select Atlas, Beacon, or Cinder first."}</p>
          <button ref={closeRef} type="button" onClick={() => sendTyped(actor, [{ type: "close", target: "library.details" }])}>
            Close details
          </button>
        </aside>
      ) : null}
    </section>
  );
}

export function ArticlePage({ registry, actor, model }: { registry: UiCapabilityRegistry; actor: InteractionActor; model: VoicePageModel }): ReactNode {
  const contentRef = useRef<HTMLDivElement>(null);
  useUiCapability(registry, "article.content", {
    supportedActions: SCROLL_ACTIONS,
    execute: async (command) => {
      if (command.type !== "scroll" || !contentRef.current) return;
      scrollRegion(contentRef.current, command.direction);
    },
  });
  useUiCapability(registry, "article.bookmark", {
    supportedActions: ACTIVATE_ACTIONS,
    execute: async (command) => {
      if (command.type !== "activate") return;
      model.setBookmarked(!model.bookmarked);
    },
  });
  return (
    <section className="page" aria-labelledby="article-title">
      <h2 id="article-title">Article</h2>
      <button
        type="button"
        aria-pressed={model.bookmarked}
        data-voice-id="article.bookmark"
        onClick={() => sendTyped(actor, [{ type: "activate", target: "article.bookmark" }])}
      >
        {model.bookmarked ? "Bookmarked" : "Bookmark"}
      </button>
      <div ref={contentRef} className="article-body scroll-region" data-voice-id="article.content" tabIndex={0} aria-label="Article content">
        {ARTICLE_PARAGRAPHS.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </div>
    </section>
  );
}

export function SettingsPage({ registry, actor, model }: { registry: UiCapabilityRegistry; actor: InteractionActor; model: VoicePageModel }): ReactNode {
  useUiCapability(registry, "settings.theme", {
    supportedActions: THEME_ACTIONS,
    execute: async (command) => {
      if (command.type !== "select" || command.target !== "settings.theme") return;
      model.setTheme(command.value);
    },
  });
  return (
    <section className="page" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings <span className="voice-id">settings.theme</span></h2>
      <div className="toolbar" role="group" aria-label="Theme">
        {(["light", "dark", "system"] as const).map((theme) => (
          <button
            key={theme}
            type="button"
            aria-pressed={model.theme === theme}
            onClick={() => sendTyped(actor, [{ type: "select", target: "settings.theme", value: theme }])}
          >
            {theme}
          </button>
        ))}
      </div>
    </section>
  );
}

export function RoutePage({ route, registry, actor, model }: {
  route: RouteId;
  registry: UiCapabilityRegistry;
  actor: InteractionActor;
  model: VoicePageModel;
}): ReactNode {
  switch (route) {
    case "dashboard":
      return <DashboardPage registry={registry} actor={actor} />;
    case "library":
      return <LibraryPage registry={registry} actor={actor} model={model} />;
    case "article":
      return <ArticlePage registry={registry} actor={actor} model={model} />;
    case "settings":
      return <SettingsPage registry={registry} actor={actor} model={model} />;
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}
