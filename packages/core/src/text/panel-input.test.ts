// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PanelInputController } from "./panel-input.js";
import { StreamingTextPanel } from "./streaming-panel.js";

describe("PanelInputController", () => {
  it("routes wheel and pointer drag inside the panel", () => {
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 300, height: 200 } as DOMRect);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
    const panel = new StreamingTextPanel();
    const scroll = vi.spyOn(panel, "scrollBy");
    const jump = vi.spyOn(panel, "jumpToLatest");
    const controller = new PanelInputController(element, panel, () => ({ x: 100, y: 20, width: 180, height: 160 }));
    const wheel = new WheelEvent("wheel", { clientX: 140, clientY: 80, deltaY: 24, cancelable: true });
    element.dispatchEvent(wheel);
    expect(scroll).toHaveBeenCalledWith(24);
    expect(wheel.defaultPrevented).toBe(true);

    const down = new MouseEvent("pointerdown", { clientX: 140, clientY: 100, bubbles: true });
    Object.defineProperty(down, "pointerId", { value: 1 });
    element.dispatchEvent(down);
    const move = new MouseEvent("pointermove", { clientX: 140, clientY: 70, bubbles: true });
    Object.defineProperty(move, "pointerId", { value: 1 });
    element.dispatchEvent(move);
    expect(scroll).toHaveBeenCalledWith(30);
    const upAfterDrag = new MouseEvent("pointerup", { clientX: 140, clientY: 70, bubbles: true });
    Object.defineProperty(upAfterDrag, "pointerId", { value: 1 });
    element.dispatchEvent(upAfterDrag);
    expect(jump).not.toHaveBeenCalled();

    const tapDown = new MouseEvent("pointerdown", { clientX: 140, clientY: 170, bubbles: true });
    Object.defineProperty(tapDown, "pointerId", { value: 2 });
    element.dispatchEvent(tapDown);
    const tapUp = new MouseEvent("pointerup", { clientX: 140, clientY: 170, bubbles: true });
    Object.defineProperty(tapUp, "pointerId", { value: 2 });
    element.dispatchEvent(tapUp);
    expect(jump).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
