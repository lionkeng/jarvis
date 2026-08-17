import { describe, expect, it } from "vitest";
import { createIdleFeatures } from "../audio/idle-features.js";
import { PretextLayout } from "./pretext-layout.js";
import { StreamingTextPanel } from "./streaming-panel.js";

describe("StreamingTextPanel", () => {
  it("does not mutate committed lines while appending", () => {
    const panel = new StreamingTextPanel(new PretextLayout("500 16px monospace"));
    panel.setViewport(84, 100);
    panel.append("one two three ", 1);
    const committed = panel.lines.filter((line) => line.complete).map((line) => line.text);
    panel.append("four five ", 2);
    expect(panel.lines.filter((line) => line.complete).slice(0, committed.length).map((line) => line.text)).toEqual(committed);
  });

  it("prepares only at boundaries and completion", () => {
    const panel = new StreamingTextPanel();
    panel.append("Hel", 1);
    panel.append("lo", 2);
    expect(panel.prepareCount).toBe(0);
    panel.append(" ", 3);
    expect(panel.prepareCount).toBe(1);
    panel.append("world", 4);
    expect(panel.prepareCount).toBe(1);
    panel.finish(5);
    expect(panel.prepareCount).toBeGreaterThan(1);
  });

  it("preserves whitespace while carrying a streaming tail", () => {
    const panel = new StreamingTextPanel();
    panel.setViewport(500, 100);
    panel.append("The ", 1);
    panel.append("center ", 2);
    panel.append("ring", 3);
    expect(panel.lines.at(-1)?.text).toBe("The center ring");
    panel.finish(4);
    expect(panel.lines[0]?.text).toBe("The center ring");
  });

  it("keeps a bottom pin and allows deliberate scrollback", () => {
    const panel = new StreamingTextPanel();
    panel.setViewport(90, 52);
    panel.append("one two three four five six seven eight ", 1);
    panel.finish(2);
    expect(panel.isPinnedToLatest).toBe(true);
    panel.scrollBy(-40);
    expect(panel.isPinnedToLatest).toBe(false);
    panel.jumpToLatest();
    expect(panel.isPinnedToLatest).toBe(true);
  });

  it("preserves the reading anchor when width changes", () => {
    const panel = new StreamingTextPanel();
    panel.setViewport(90, 52);
    panel.append("one two three four five six seven eight nine ten eleven twelve ", 1);
    panel.finish(2);
    panel.scrollBy(-52);
    const anchor = panel.scrollAnchorLine;
    panel.setViewport(70, 52);
    expect(panel.scrollAnchorLine).toBe(anchor);
    expect(panel.isPinnedToLatest).toBe(false);
  });

  it("clips to the panel and reveals delta tokens by their actual arrival times", () => {
    const panel = new StreamingTextPanel(new PretextLayout("500 16px monospace"));
    panel.append("Earlier ", 0);
    panel.append("later", 100);
    const active = panel.lines.at(-1);
    expect(active?.tokens.map((token) => [token.text, token.arrivedAt])).toEqual([["Earlier ", 0], ["later", 100]]);

    const draws: Array<{ text: string; alpha: number }> = [];
    const clipped: Array<[number, number, number, number]> = [];
    const context = {
      globalAlpha: 1, fillStyle: "", font: "", textBaseline: "alphabetic", shadowColor: "", shadowBlur: 0,
      save() {}, restore() {}, beginPath() {}, clip() {}, fillRect() {}, translate() {}, rotate() {}, scale() {},
      rect(x: number, y: number, width: number, height: number) { clipped.push([x, y, width, height]); },
      fillText(text: string) { draws.push({ text, alpha: context.globalAlpha }); },
      measureText(text: string) { return { width: text.length * 8 } as TextMetrics; },
    } as unknown as CanvasRenderingContext2D;
    const rect = { x: 40, y: 30, width: 300, height: 160 };
    panel.paint(context, rect, 120, {
      foreground: "#fff", muted: "#888", accent: "#0ff", surface: "#000",
      state: "speaking", features: createIdleFeatures(120), reducedMotion: false, textMotion: "flow",
    });

    expect(clipped).toContainEqual([rect.x, rect.y, rect.width, rect.height]);
    const earlier = draws.find((draw) => draw.text === "Earlier ");
    const later = draws.find((draw) => draw.text === "later");
    expect(earlier?.alpha).toBeGreaterThan(later?.alpha ?? 1);
  });

  it("keeps preparation at word rate and paints only a bounded window of 100+ lines", () => {
    const panel = new StreamingTextPanel(new PretextLayout("500 16px monospace"));
    panel.setViewport(64, 52);
    for (let index = 0; index < 220; index += 1) panel.append(`word${index} `, index);
    panel.finish(221);
    expect(panel.prepareCount).toBeLessThanOrEqual(221);
    expect(panel.lines.length).toBeGreaterThan(100);

    let paintedText = 0;
    const context = {
      globalAlpha: 1, fillStyle: "", font: "", textBaseline: "alphabetic", shadowColor: "", shadowBlur: 0,
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, translate() {}, rotate() {}, scale() {},
      fillText() { paintedText += 1; },
      measureText(text: string) { return { width: text.length * 8 } as TextMetrics; },
    } as unknown as CanvasRenderingContext2D;
    panel.paint(context, { x: 0, y: 0, width: 96, height: 120 }, 300, {
      foreground: "#fff", muted: "#888", accent: "#0ff", surface: "#000",
      state: "speaking", features: createIdleFeatures(300), reducedMotion: true, textMotion: "flow",
    });
    expect(paintedText).toBeLessThan(30);
  });

  it("lays out unspaced Chinese text incrementally and preserves every character", () => {
    const panel = new StreamingTextPanel(new PretextLayout("500 16px monospace"));
    panel.setViewport(64, 104);
    const transcript = "普通话是主要语言，粤语也应该得到完整支持。";
    for (const grapheme of transcript) panel.append(grapheme, 1);

    expect(panel.prepareCount).toBeGreaterThan(0);
    panel.finish(2);
    expect(panel.lines.map((line) => line.text).join("")).toBe(transcript);
    expect(panel.lines.length).toBeGreaterThan(1);
  });
});
