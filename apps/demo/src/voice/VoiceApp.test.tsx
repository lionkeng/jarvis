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

function lifetimeResponse(signal: AbortSignal | null | undefined) {
  let timer: ReturnType<typeof setInterval>;
  let finish = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = () => controller.enqueue(new TextEncoder().encode("data: alive\n\n"));
      controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
      timer = setInterval(heartbeat, 5_000);
      finish = () => {
        clearInterval(timer);
        signal?.removeEventListener("abort", finish);
        controller.close();
      };
      signal?.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      clearInterval(timer);
      signal?.removeEventListener("abort", finish);
    },
  });
  return { response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }), finish: () => finish() };
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

  it("posts the session endpoint when Connect is clicked in live mode", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "Origin is not allowed" }), { status: 403 })
      : lifetimeResponse(init?.signal).response);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("RTCPeerConnection", class {
      iceGatheringState = "complete";
      localDescription = { type: "offer", sdp: "v=0" };
      addEventListener() {}
      addTrack() {}
      close() {}
      createDataChannel() { return { addEventListener() {}, close() {} }; }
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {}
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    const { host, root } = await mountApp();
    await act(async () => { namedButton(host, ".toolbar", "OpenAI live").click(); });
    await settle();
    expect(namedButton(host, ".session", "Connect")).toBeInstanceOf(HTMLButtonElement);
    await act(async () => { namedButton(host, ".session", "Connect").click(); });
    await settle();
    expect(fetchMock).toHaveBeenCalled();
    const sessionCall = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    expect(sessionCall?.[0]).toBe("http://localhost:3010/session");
    expect(host.querySelector(".toolbar span")?.textContent).toMatch(/Session endpoint failed|Origin is not allowed|Failed to fetch|Connecting/);
    await unmountApp(root, host);
  });

  it.each(["close timeout", "server loss"])("keeps %s visible and unlocks connection controls", async (reason) => {
    let deliver: ((event: { data: string }) => void) | undefined;
    let lifetime: ReturnType<typeof lifetimeResponse> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0" } });
      lifetime = lifetimeResponse(init?.signal);
      return lifetime.response;
    }));
    const channel = {
      readyState: "open",
      send() {}, close() {},
      addEventListener(name: string, listener: (event: { data: string }) => void) { if (name === "message") deliver = listener; },
    };
    vi.stubGlobal("RTCPeerConnection", class {
      iceGatheringState = "complete";
      localDescription = { type: "offer", sdp: "v=0" };
      addEventListener() {} addTrack() {} close() {}
      createDataChannel() { return channel; }
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {}
      async setRemoteDescription() { deliver?.({ data: JSON.stringify({ type: "session.started" }) }); }
    });
    const stopMicrophone = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopMicrophone }] }) } });
    const { host, root } = await mountApp();
    await act(async () => { namedButton(host, ".toolbar", "OpenAI live").click(); });
    await act(async () => { namedButton(host, ".session", "Connect").click(); });
    await settle();
    if (reason === "close timeout") {
      await act(async () => { namedButton(host, ".session", "Disconnect").click(); });
      expect(namedButton(host, ".session", "Finishing…").disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    } else {
      await act(async () => { lifetime!.finish(); });
      expect(stopMicrophone).toHaveBeenCalledOnce();
    }
    expect(host.querySelector(".toolbar span")?.textContent).toContain("usage is unconfirmed");
    expect(namedButton(host, ".session", "Connect").disabled).toBe(false);
    await unmountApp(root, host);
  });

  it("shows rejected commands and failed backend responses without dropping the live session", async () => {
    let deliver: ((event: { data: string }) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0" } })
      : lifetimeResponse(init?.signal).response));
    const channel = {
      readyState: "open",
      send() {}, close() {},
      addEventListener(name: string, listener: (event: { data: string }) => void) { if (name === "message") deliver = listener; },
    };
    vi.stubGlobal("RTCPeerConnection", class {
      iceGatheringState = "complete";
      localDescription = { type: "offer", sdp: "v=0" };
      addEventListener() {} addTrack() {} close() {}
      createDataChannel() { return channel; }
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {}
      async setRemoteDescription() { deliver?.({ data: JSON.stringify({ type: "session.started" }) }); }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    const { host, root } = await mountApp();
    await act(async () => { namedButton(host, ".toolbar", "OpenAI live").click(); });
    await act(async () => { namedButton(host, ".session", "Connect").click(); });
    await settle();
    const send = (event: unknown) => deliver?.({ data: JSON.stringify(event) });

    await act(async () => { send({ type: "error", error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter", client_event_id: "evt_1" } }); });
    expect(host.querySelector(".toolbar span")?.textContent).toBe("Unknown parameter");

    await act(async () => {
      send({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.created", response: { id: "resp_1", output: [] } } });
      send({ type: "response.event", delegation_id: "delegation_1", event: { type: "response.failed", response: { id: "resp_1" } } });
    });
    expect(host.querySelector(".toolbar span")?.textContent).toBe("Backend response failed");
    expect(namedButton(host, ".session", "Disconnect").disabled).toBe(false);
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
