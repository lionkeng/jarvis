import type { Rect } from "../layout/types.js";
import { StreamingTextPanel } from "./streaming-panel.js";

export class PanelInputController {
  #dragY: number | undefined;
  #dragDistance = 0;
  readonly #panel: StreamingTextPanel;
  readonly #element: HTMLElement;
  readonly #getRect: () => Rect;

  constructor(element: HTMLElement, panel: StreamingTextPanel, getRect: () => Rect) {
    this.#element = element;
    this.#panel = panel;
    this.#getRect = getRect;
    element.addEventListener("wheel", this.#onWheel, { passive: false });
    element.addEventListener("pointerdown", this.#onPointerDown);
    element.addEventListener("pointermove", this.#onPointerMove);
    element.addEventListener("pointerup", this.#onPointerUp);
    element.addEventListener("pointercancel", this.#onPointerUp);
  }

  dispose(): void {
    this.#element.removeEventListener("wheel", this.#onWheel);
    this.#element.removeEventListener("pointerdown", this.#onPointerDown);
    this.#element.removeEventListener("pointermove", this.#onPointerMove);
    this.#element.removeEventListener("pointerup", this.#onPointerUp);
    this.#element.removeEventListener("pointercancel", this.#onPointerUp);
  }

  #contains(event: PointerEvent | WheelEvent): boolean {
    const bounds = this.#element.getBoundingClientRect();
    const rect = this.#getRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  #onWheel = (event: WheelEvent): void => {
    if (!this.#contains(event)) return;
    event.preventDefault();
    this.#panel.scrollBy(event.deltaY);
  };

  #onPointerDown = (event: PointerEvent): void => {
    if (!this.#contains(event)) return;
    this.#dragY = event.clientY;
    this.#dragDistance = 0;
    this.#element.setPointerCapture(event.pointerId);
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#dragY === undefined) return;
    const delta = this.#dragY - event.clientY;
    this.#dragDistance += Math.abs(delta);
    this.#panel.scrollBy(delta);
    this.#dragY = event.clientY;
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (this.#dragY === undefined) return;
    const shouldJump = event.type === "pointerup" && this.#dragDistance < 5 && this.#isJumpTarget(event);
    this.#dragY = undefined;
    this.#dragDistance = 0;
    if (this.#element.hasPointerCapture(event.pointerId)) this.#element.releasePointerCapture(event.pointerId);
    if (shouldJump) this.#panel.jumpToLatest();
  };

  #isJumpTarget(event: PointerEvent): boolean {
    if (!this.#contains(event)) return false;
    const bounds = this.#element.getBoundingClientRect();
    const rect = this.#getRect();
    return event.clientY - bounds.top >= rect.y + rect.height - 28;
  }
}
