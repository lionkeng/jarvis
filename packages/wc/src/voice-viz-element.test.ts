// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceViz, type RealtimeTransport } from "@jarvis-viz/core";
import { defineVoiceVizElement, VoiceVizElement } from "./voice-viz-element.js";

class FakeTransport implements RealtimeTransport {
  connected = false;
  readonly agentAudio = null;
  readonly endpoints: string[] = [];
  disconnects = 0;
  #cancel: ((error: Error) => void) | undefined;
  constructor(readonly holdConnect = false) {}
  connect(tokenEndpoint: string): Promise<void> {
    this.endpoints.push(tokenEndpoint);
    if (this.holdConnect) return new Promise<void>((_resolve, reject) => { this.#cancel = reject; });
    this.connected = true;
    return Promise.resolve();
  }
  disconnect(): void {
    this.disconnects += 1;
    this.connected = false;
    this.#cancel?.(new Error("Live connection cancelled"));
    this.#cancel = undefined;
  }
  subscribe(): () => void {
    return () => {};
  }
  submitToolResult(): void {}
}

interface RejectionHost {
  on(name: "unhandledRejection", listener: (reason: unknown) => void): void;
  off(name: "unhandledRejection", listener: (reason: unknown) => void): void;
}

const rejectionHost = (globalThis as { process?: RejectionHost }).process;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("VoiceVizElement", () => {
  beforeEach(() => {
    defineVoiceVizElement();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, arc() {}, fillText() {}, translate() {}, rotate() {},
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "", textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => vi.restoreAllMocks());

  it("mounts inside shadow DOM and removes its canvas on disconnect", () => {
    const element = document.createElement("jarvis-voice-viz");
    document.body.append(element);
    expect(element.shadowRoot?.querySelector("canvas")).not.toBeNull();
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain(":host");
    expect(element.shadowRoot?.querySelector("style")?.textContent).toContain("font: normal 16px/1.5");
    element.remove();
    expect(element.shadowRoot?.querySelector("canvas")).toBeNull();
  });

  it("lets hosts await session finalization", async () => {
    let finish!: () => void;
    const closing = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(VoiceViz.prototype, "disconnect").mockReturnValue(closing);
    const element = new VoiceVizElement();
    document.body.append(element);
    const done = element.disconnect();
    expect(done).toBeInstanceOf(Promise);
    let finalized = false;
    void Promise.resolve(done).then(() => { finalized = true; });
    await Promise.resolve();
    expect(finalized).toBe(false);
    finish();
    await done;
    expect(finalized).toBe(true);
    element.remove();
  });

  it("connects through a transport assigned before the element is attached", async () => {
    const transport = new FakeTransport();
    const element = new VoiceVizElement();
    element.transport = transport;
    element.setAttribute("token-endpoint", "/live-session");
    document.body.append(element);
    await element.connect();
    expect(transport.endpoints).toEqual(["/live-session"]);
    await element.disconnect();
    element.remove();
  });

  it("rebuilds the instance when a transport is assigned after the element is attached", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const element = new VoiceVizElement();
    element.transport = first;
    document.body.append(element);
    const canvas = element.shadowRoot?.querySelector("canvas");
    element.transport = second;
    expect(first.disconnects).toBe(1);
    expect(element.shadowRoot?.querySelector("canvas")).not.toBe(canvas);
    element.transport = second;
    expect(second.disconnects).toBe(0);
    await element.connect();
    expect(second.endpoints).toEqual(["/session"]);
    expect(first.endpoints).toEqual([]);
    await element.disconnect();
    element.remove();
  });

  it("refuses to swap a transport under a live session", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const element = new VoiceVizElement();
    element.transport = first;
    document.body.append(element);
    await element.connect();
    const canvas = element.shadowRoot?.querySelector("canvas");
    expect(() => { element.transport = second; }).toThrow(/disconnect/i);
    expect(element.transport).toBe(first);
    expect(element.shadowRoot?.querySelector("canvas")).toBe(canvas);
    expect(second.endpoints).toEqual([]);
    await element.disconnect();
    element.transport = second;
    await element.connect();
    expect(second.endpoints).toEqual(["/session"]);
    await element.disconnect();
    element.remove();
  });

  it("keeps its transport across a disconnect and reconnect of the element", async () => {
    const transport = new FakeTransport();
    const element = new VoiceVizElement();
    element.transport = transport;
    document.body.append(element);
    element.remove();
    expect(element.transport).toBe(transport);
    document.body.append(element);
    await element.connect();
    expect(transport.endpoints).toEqual(["/session"]);
    await element.disconnect();
    element.remove();
  });

  it("honors a transport assigned before the element is defined", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string) => { requests.push(input); return new Promise<Response>(() => {}); }));
    const transport = new FakeTransport();
    const element = document.createElement("jarvis-voice-viz-late");
    element.setAttribute("token-endpoint", "/live-session");
    element.setAttribute("auto-connect", "");
    document.body.append(element);
    (element as { transport?: RealtimeTransport }).transport = transport;
    if (!customElements.get("jarvis-voice-viz-late")) customElements.define("jarvis-voice-viz-late", class extends VoiceVizElement {});
    await flush();
    expect((element as VoiceVizElement).transport).toBe(transport);
    expect(requests).toEqual([]);
    expect(transport.endpoints).toEqual(["/live-session"]);
    element.remove();
  });

  it("re-runs auto-connect on a transport swapped in while the first connect is pending", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    rejectionHost?.on("unhandledRejection", onRejection);
    const first = new FakeTransport(true);
    const second = new FakeTransport();
    const element = document.createElement("jarvis-voice-viz") as VoiceVizElement;
    element.setAttribute("token-endpoint", "/live-session");
    element.setAttribute("auto-connect", "");
    element.transport = first;
    document.body.append(element);
    expect(first.endpoints).toEqual(["/live-session"]);
    expect(first.connected).toBe(false);
    element.transport = second;
    expect(first.disconnects).toBe(1);
    expect(second.endpoints).toEqual(["/live-session"]);
    await flush();
    rejectionHost?.off("unhandledRejection", onRejection);
    expect(rejections).toEqual([]);
    await element.disconnect();
    element.remove();
  });

  it("ignores a transport attribute and still connects through the default transport", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string) => { requests.push(input); return Promise.reject(new Error("no broker")); }));
    const element = document.createElement("jarvis-voice-viz") as VoiceVizElement;
    element.setAttribute("transport", "x");
    element.setAttribute("live-provider", "gemini-live");
    element.setAttribute("token-endpoint", "/live-session");
    document.body.append(element);
    expect(element.transport).toBeUndefined();
    await expect(element.connect()).rejects.toThrow(/broker/i);
    expect(requests).toEqual(["/live-session"]);
    element.remove();
  });
});
