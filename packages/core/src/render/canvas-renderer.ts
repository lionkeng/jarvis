import type { RendererFrameState, VisualizationPreset, VizFrame } from "./types.js";

export type FrameProvider = (now: number) => RendererFrameState;

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  #presets: VisualizationPreset[] = [];
  #frameProvider?: FrameProvider;
  #frameHandle = 0;
  #lastTime = 0;
  #resizeObserver?: ResizeObserver;
  #width = 1;
  #height = 1;
  #pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement, resizeTarget: Element = canvas) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;
    this.#resizeObserver = new ResizeObserver(() => this.resize());
    this.#resizeObserver.observe(resizeTarget);
    this.resize();
  }

  get size(): { width: number; height: number } {
    return { width: this.#width, height: this.#height };
  }

  setPresets(presets: VisualizationPreset[]): void {
    for (const preset of this.#presets) preset.dispose?.();
    this.#presets = [...presets].sort((left, right) => left.layer - right.layer);
  }

  start(provider: FrameProvider): void {
    this.#frameProvider = provider;
    if (!this.#frameHandle) this.#frameHandle = requestAnimationFrame(this.#tick);
  }

  stop(): void {
    if (this.#frameHandle) cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = 0;
    this.#lastTime = 0;
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.#width = Math.max(1, bounds.width || this.canvas.clientWidth || 1);
    this.#height = Math.max(1, bounds.height || this.canvas.clientHeight || 1);
    this.#pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(this.#width * this.#pixelRatio);
    const pixelHeight = Math.round(this.#height * this.#pixelRatio);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.context.setTransform(this.#pixelRatio, 0, 0, this.#pixelRatio, 0, 0);
    }
  }

  render(now: number, state: RendererFrameState): void {
    const deltaSeconds = this.#lastTime === 0 ? 1 / 60 : Math.min(0.1, (now - this.#lastTime) / 1000);
    this.#lastTime = now;
    const frame: VizFrame = {
      context: this.context,
      width: this.#width,
      height: this.#height,
      pixelRatio: this.#pixelRatio,
      now,
      deltaSeconds,
      ...state,
    };
    this.context.fillStyle = state.theme.background;
    this.context.globalAlpha = state.theme.trailOpacity;
    this.context.fillRect(0, 0, this.#width, this.#height);
    this.context.globalAlpha = 1;
    this.context.save();
    this.context.beginPath();
    this.context.rect(state.regions.viz.x, state.regions.viz.y, state.regions.viz.width, state.regions.viz.height);
    this.context.clip();
    for (const preset of this.#presets) preset.paint(frame);
    this.context.restore();
    state.paintPanel?.(frame);
  }

  dispose(): void {
    this.stop();
    this.#resizeObserver?.disconnect();
    for (const preset of this.#presets) preset.dispose?.();
    this.#presets = [];
  }

  #tick = (now: number): void => {
    if (!this.#frameProvider) return;
    this.render(now, this.#frameProvider(now));
    this.#frameHandle = requestAnimationFrame(this.#tick);
  };
}
