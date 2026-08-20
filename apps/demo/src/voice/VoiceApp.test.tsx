// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceApp } from "./VoiceApp.js";

function stubBrowser(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, arc() {}, fillText() {}, translate() {}, rotate() {}, scale() {},
    measureText: (text: string) => ({ width: text.length * 8 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "", textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 640, height: 480 } as DOMRect);
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === "object" && options && "top" in options && typeof options.top === "number") this.scrollTop = options.top;
  };
  HTMLElement.prototype.scrollBy = function scrollBy(this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === "object" && options && "top" in options && typeof options.top === "number") this.scrollTop += options.top;
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 24; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }
}

function namedButton(host: HTMLElement, scope: string, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll(`${scope} button`)].find((node) => node.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${scope} button ${label}`);
  return button;
}

function namedLink(host: HTMLElement, label: string): HTMLAnchorElement {
  const link = [...host.querySelectorAll("nav.routes a")].find((node) => node.textContent === label);
  if (!(link instanceof HTMLAnchorElement)) throw new Error(`missing route ${label}`);
  return link;
}

async function mountApp(): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot>; seenStates: Set<string> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const seenStates = new Set<string>();
  const observer = new MutationObserver(() => {
    const state = host.querySelector('[data-testid="activity-state"]')?.textContent;
    if (state) seenStates.add(state);
  });
  await act(async () => { root.render(<StrictMode><VoiceApp /></StrictMode>); });
  const activity = host.querySelector(".activity");
  if (activity) observer.observe(activity, { subtree: true, characterData: true, childList: true });
  return { host, root, seenStates };
}

async function unmountApp(root: ReturnType<typeof createRoot>, host: HTMLElement): Promise<void> {
  await act(async () => { root.unmount(); });
  host.remove();
}

describe("VoiceApp", () => {
  beforeEach(() => {
    window.location.hash = "";
    document.documentElement.removeAttribute("data-theme");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    stubBrowser();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("falls unknown hashes back to dashboard and navigates from pointer controls", async () => {
    window.location.hash = "#/not-a-page";
    const { host, root } = await mountApp();
    expect(host.querySelector("#dashboard-title")).not.toBeNull();
    await act(async () => { namedLink(host, "library").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(host.querySelector("#library-title")).not.toBeNull();
    expect(host.querySelector('[data-testid="activity-state"]')?.textContent).toBe("ready");
    await unmountApp(root, host);
  });

  it("runs a simulated voice navigation and a compound navigate-then-scroll", async () => {
    const { host, root, seenStates } = await mountApp();
    await act(async () => { namedButton(host, ".scripts", "Open the library").click(); });
    await settle();
    expect(host.querySelector("#library-title")).not.toBeNull();
    await act(async () => { namedButton(host, ".scripts", "Open article and scroll").click(); });
    await settle();
    expect(host.querySelector("#article-title")).not.toBeNull();
    const article = host.querySelector("[data-voice-id='article.content']");
    expect(article).toBeInstanceOf(HTMLElement);
    if (article instanceof HTMLElement) expect(article.scrollTop).toBe(240);
    expect(host.querySelector('[data-testid="activity-result"]')?.textContent).not.toBe("none");
    expect(seenStates.has("validating") || seenStates.has("executing") || seenStates.has("reporting")).toBe(true);
    expect(host.querySelector('[data-testid="activity-state"]')?.textContent).toBe("ready");
    await unmountApp(root, host);
  });

  it("selects a library item, opens and closes the drawer, and focuses search", async () => {
    const { host, root } = await mountApp();
    await act(async () => { namedLink(host, "library").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    const atlas = [...host.querySelectorAll(".page button")].find((node) => node.textContent?.startsWith("Atlas"));
    if (!(atlas instanceof HTMLButtonElement)) throw new Error("missing Atlas card");
    await act(async () => { atlas.click(); });
    await settle();
    expect(atlas.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { namedButton(host, ".page", "Open details").click(); });
    await settle();
    expect(host.querySelector("#details-title")).not.toBeNull();
    await act(async () => { namedButton(host, ".page", "Close details").click(); });
    await settle();
    expect(host.querySelector("#details-title")).toBeNull();
    await act(async () => { namedLink(host, "dashboard").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    const search = host.querySelector("input[name='dashboard-search']");
    await act(async () => { namedButton(host, ".page", "Focus search").click(); });
    await settle();
    expect(document.activeElement).toBe(search);
    await unmountApp(root, host);
  });

  it("changes theme and bookmarks from the same actor path", async () => {
    const { host, root } = await mountApp();
    await act(async () => { namedLink(host, "settings").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    await act(async () => { namedButton(host, ".page", "light").click(); });
    await settle();
    expect(document.documentElement.dataset.theme).toBe("light");
    await act(async () => { namedLink(host, "article").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    const bookmark = namedButton(host, ".page", "Bookmark");
    bookmark.focus();
    await act(async () => { bookmark.click(); });
    await settle();
    expect(namedButton(host, ".page", "Bookmarked")).toBeInstanceOf(HTMLButtonElement);
    await unmountApp(root, host);
  });

  it("answers an ordinary question without mutating UI state and cleans up on unmount", async () => {
    const { host, root } = await mountApp();
    await act(async () => { namedButton(host, ".scripts", "Ask an ordinary question").click(); });
    await settle();
    expect(host.querySelector("#dashboard-title")).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(host.querySelector('[data-testid="activity-result"]')?.textContent).toBe("none");
    await unmountApp(root, host);
    expect(cancelAnimationFrame).toHaveBeenCalled();
    window.location.hash = "#/library";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(document.body.contains(host)).toBe(false);
  });
});
