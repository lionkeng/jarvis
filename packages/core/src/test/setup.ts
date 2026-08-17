class TestMeasureContext {
  font = "16px sans-serif";
  measureText(text: string): TextMetrics {
    const size = Number.parseFloat(this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16");
    return { width: [...text].reduce((width, character) => width + (/\s/u.test(character) ? size * 0.34 : size * 0.61), 0) } as TextMetrics;
  }
}

if (typeof globalThis.OffscreenCanvas === "undefined") {
  globalThis.OffscreenCanvas = class {
    constructor(public width: number, public height: number) {}
    getContext(): OffscreenCanvasRenderingContext2D { return new TestMeasureContext() as unknown as OffscreenCanvasRenderingContext2D; }
  } as unknown as typeof OffscreenCanvas;
}
