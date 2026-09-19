// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceViz, type RealtimeTransport } from "@jarvis-viz/core";
import { defineVoiceVizElement, VoiceVizElement } from "./voice-viz-element.js";

class FakeTransport implements RealtimeTransport {
  connected = false;
  readonly agentAudio = null;
  readonly endpoints: string[] = [];
  disconnects = 0;
  async connect(tokenEndpoint: string): Promise<void> {
    this.endpoints.push(tokenEndpoint);
    this.connected = true;
  }
  disconnect(): void {
    this.disconnects += 1;
    this.connected = false;
  }
  subscribe(): () => void {
    return () => {};
  }
  submitToolResult(): void {}
}

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

  it("adds no observed attribute for the transport", () => {
    expect(VoiceVizElement.observedAttributes).toEqual(["presets", "theme", "panel-placement"]);
  });
});
