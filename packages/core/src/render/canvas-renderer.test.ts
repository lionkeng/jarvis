import { describe, expect, it, vi } from "vitest";
import { CanvasRenderer } from "./canvas-renderer.js";
import { createIdleFeatures } from "../audio/idle-features.js";
import { computeRegions } from "../layout/regions.js";
import { themes } from "./theme.js";
import { PresetRegistry } from "./registry.js";

describe("CanvasRenderer", () => {
  it("clips visualization presets to the visualization region", () => {
    const context = {
      setTransform: vi.fn(), fillRect: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(),
      fillStyle: "", globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 100, height: 100, clientWidth: 100, clientHeight: 100,
      getContext: () => context,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    } as unknown as HTMLCanvasElement;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    const renderer = new CanvasRenderer(canvas);
    const paint = vi.fn();
    renderer.setPresets([{ name: "test", layer: 0, paint }]);
    const regions = computeRegions(100, 100, { inset: 0 });
    renderer.render(1, { state: "idle", stateAge: 0, features: createIdleFeatures(1), regions, theme: themes.cyan, reducedMotion: true });
    expect(context.rect).toHaveBeenCalledWith(regions.viz.x, regions.viz.y, regions.viz.width, regions.viz.height);
    expect(context.clip).toHaveBeenCalled();
    expect(paint).toHaveBeenCalledOnce();
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  it("renders every named preset through the clipped renderer pass", () => {
    const operations: string[] = [];
    const operation = (name: string) => vi.fn(() => operations.push(name));
    const gradient = { addColorStop: operation("addColorStop") } as unknown as CanvasGradient;
    const context = {
      setTransform: operation("setTransform"), fillRect: operation("fillRect"), save: operation("save"), beginPath: operation("beginPath"),
      rect: operation("rect"), clip: operation("clip"), restore: operation("restore"), arc: operation("arc"), stroke: operation("stroke"),
      moveTo: operation("moveTo"), lineTo: operation("lineTo"), closePath: operation("closePath"), fillText: operation("fillText"),
      fill: operation("fill"), createLinearGradient: vi.fn(() => gradient), createRadialGradient: vi.fn(() => gradient),
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, font: "",
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 320, height: 200, clientWidth: 320, clientHeight: 200,
      getContext: () => context,
      getBoundingClientRect: () => ({ width: 320, height: 200 }),
    } as unknown as HTMLCanvasElement;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    const renderer = new CanvasRenderer(canvas);
    const presets = new PresetRegistry().create(["bars", "waveform", "ring", "particles", "hud"]);
    const paints = presets.map((preset) => vi.spyOn(preset, "paint"));
    renderer.setPresets(presets);
    const regions = computeRegions(320, 200, { inset: 0 });
    expect(() => renderer.render(1, { state: "speaking", stateAge: 0, features: createIdleFeatures(1), regions, theme: themes.cyan, reducedMotion: false })).not.toThrow();
    for (const paint of paints) expect(paint).toHaveBeenCalledOnce();
    expect(operations.indexOf("clip")).toBeGreaterThan(operations.indexOf("rect"));
    expect(operations.lastIndexOf("restore")).toBeGreaterThan(operations.indexOf("clip"));
    renderer.dispose();
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  it("owns stable layer ordering even when callers provide presets out of order", () => {
    const context = {
      setTransform() {}, fillRect() {}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {},
      fillStyle: "", globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 100, height: 100, clientWidth: 100, clientHeight: 100,
      getContext: () => context, getBoundingClientRect: () => ({ width: 100, height: 100 }),
    } as unknown as HTMLCanvasElement;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    const order: string[] = [];
    const renderer = new CanvasRenderer(canvas);
    renderer.setPresets([
      { name: "foreground", layer: 20, paint: () => order.push("foreground") },
      { name: "background", layer: 10, paint: () => order.push("background") },
    ]);
    const regions = computeRegions(100, 100, { inset: 0 });
    renderer.render(1, { state: "idle", stateAge: 0, features: createIdleFeatures(1), regions, theme: themes.cyan, reducedMotion: true });
    expect(order).toEqual(["background", "foreground"]);
    renderer.dispose();
    globalThis.ResizeObserver = OriginalResizeObserver;
  });
});
