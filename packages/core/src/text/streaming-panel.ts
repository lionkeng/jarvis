import type { VoiceFeatures } from "../audio/types.js";
import type { Rect } from "../layout/types.js";
import type { AgentState } from "../state/types.js";
import type { TextMotion } from "../render/theme.js";
import { flowAlpha, flowOffset } from "./motion/flow.js";
import { kineticTransform } from "./motion/kinetic.js";
import { PretextLayout } from "./pretext-layout.js";
import { containsAtLeastGraphemes, containsCjkText } from "./segmentation.js";

export interface PanelLine {
  id: number;
  text: string;
  width: number;
  arrivedAt: number;
  complete: boolean;
  tokens: readonly PanelToken[];
}

export interface PanelToken {
  text: string;
  arrivedAt: number;
}

export interface PanelPaintOptions {
  foreground: string;
  muted: string;
  accent: string;
  surface: string;
  state: AgentState;
  features: VoiceFeatures;
  reducedMotion: boolean;
  textMotion: TextMotion;
}

interface Utterance {
  text: string;
  startedAt: number;
  chunks: readonly TimedChunk[];
}

interface TimedChunk {
  text: string;
  arrivedAt: number;
}

const BOUNDARY = /[\s\p{P}\u2000-\u206f]$/u;
const CJK_LAYOUT_BATCH = 4;
const FLOW_TRANSFORM = { x: 0, y: 0, rotation: 0, tracking: 0, scaleX: 1, scaleY: 1, alpha: 1, glow: 0 } as const;

export class StreamingTextPanel {
  readonly layout: PretextLayout;
  #width = 320;
  #lineHeight = 26;
  #lines: PanelLine[] = [];
  #tail = "";
  #pending = "";
  #currentText = "";
  #currentStartedAt = 0;
  #currentChunks: TimedChunk[] = [];
  #activeStart = 0;
  #utterances: Utterance[] = [];
  #nextLineId = 1;
  #scrollTop = 0;
  #viewportHeight = 180;
  #pinned = true;

  constructor(layout = new PretextLayout()) {
    this.layout = layout;
  }

  get lines(): readonly PanelLine[] {
    const active = this.#tail + this.#pending;
    if (!active) return this.#lines;
    const tokens = tokensForRange(this.#currentChunks, this.#activeStart, this.#currentText.length, active, this.#currentStartedAt);
    return [...this.#lines, {
      id: this.#nextLineId,
      text: active,
      width: 0,
      arrivedAt: tokens[0]?.arrivedAt ?? this.#currentStartedAt,
      complete: false,
      tokens,
    }];
  }

  get prepareCount(): number {
    return this.layout.prepareCount;
  }

  get isPinnedToLatest(): boolean {
    return this.#pinned;
  }

  get scrollAnchorLine(): number {
    return Math.floor(this.#scrollTop / this.#lineHeight);
  }

  append(delta: string, arrivedAt = performance.now()): void {
    if (!delta) return;
    if (!this.#currentText) this.#currentStartedAt = arrivedAt;
    this.#currentText += delta;
    this.#currentChunks.push({ text: delta, arrivedAt });
    this.#pending += delta;
    const cjkBatchReady = containsCjkText(this.#pending)
      && containsAtLeastGraphemes(this.#pending, CJK_LAYOUT_BATCH);
    if (BOUNDARY.test(this.#pending) || cjkBatchReady) this.#layoutPending(arrivedAt, false);
  }

  finish(arrivedAt = performance.now()): void {
    this.#layoutPending(arrivedAt, true);
    if (this.#tail) {
      const line = this.layout.lines(this.#tail, this.#width)[0];
      const tokens = tokensForRange(this.#currentChunks, this.#activeStart, this.#currentText.length, this.#tail, arrivedAt);
      this.#lines.push({
        id: this.#nextLineId++,
        text: this.#tail,
        width: line?.width ?? 0,
        arrivedAt: tokens[0]?.arrivedAt ?? arrivedAt,
        complete: true,
        tokens,
      });
      this.#tail = "";
    }
    if (this.#currentText) this.#utterances.push({ text: this.#currentText, startedAt: this.#currentStartedAt, chunks: [...this.#currentChunks] });
    this.#currentText = "";
    this.#pending = "";
    this.#currentChunks = [];
    this.#currentStartedAt = 0;
    this.#activeStart = 0;
    this.layout.clear();
    this.#syncPinned();
  }

  clear(): void {
    this.#lines = [];
    this.#tail = "";
    this.#pending = "";
    this.#currentText = "";
    this.#currentChunks = [];
    this.#currentStartedAt = 0;
    this.#activeStart = 0;
    this.#utterances = [];
    this.#nextLineId = 1;
    this.#scrollTop = 0;
    this.#pinned = true;
    this.layout.clear();
  }

  setViewport(width: number, height: number): void {
    const nextWidth = Math.max(40, width);
    this.#viewportHeight = Math.max(this.#lineHeight, height);
    if (Math.abs(nextWidth - this.#width) > 0.5) {
      this.#width = nextWidth;
      this.#reflowAll();
    } else {
      this.#syncPinned();
    }
  }

  scrollBy(delta: number): void {
    this.#scrollTop = Math.min(this.#maxScroll(), Math.max(0, this.#scrollTop + delta));
    this.#pinned = this.#maxScroll() - this.#scrollTop < this.#lineHeight * 0.75;
  }

  jumpToLatest(): void {
    this.#pinned = true;
    this.#scrollTop = this.#maxScroll();
  }

  paint(context: CanvasRenderingContext2D, rect: Rect, now: number, options: PanelPaintOptions): void {
    const padding = 16;
    this.setViewport(rect.width - padding * 2, rect.height - padding * 2 - 22);
    const allLines = this.lines;
    const contentTop = rect.y + padding + 22;
    context.save();
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    context.fillStyle = options.surface;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillStyle = options.muted;
    context.fillText(options.state.toUpperCase(), rect.x + padding, rect.y + 17);
    context.font = this.layout.font;
    context.textBaseline = "alphabetic";

    const first = Math.max(0, Math.floor(this.#scrollTop / this.#lineHeight));
    const visible = Math.ceil(this.#viewportHeight / this.#lineHeight) + 2;
    const offset = this.#scrollTop - first * this.#lineHeight;
    for (let index = first; index < Math.min(allLines.length, first + visible); index += 1) {
      const line = allLines[index];
      if (!line) continue;
      const baseY = contentTop + (index - first + 1) * this.#lineHeight - offset;
      let tokenX = rect.x + padding;
      for (let tokenIndex = 0; tokenIndex < line.tokens.length; tokenIndex += 1) {
        const token = line.tokens[tokenIndex];
        if (!token) continue;
        const motion = options.textMotion === "kinetic"
          ? kineticTransform(tokenIndex, line.tokens.length, index, options.features, options.state, now, options.reducedMotion)
          : FLOW_TRANSFORM;
        const alpha = flowAlpha(token.arrivedAt, now, options.reducedMotion) * motion.alpha;
        context.save();
        context.globalAlpha = alpha * (line.complete ? 0.82 : 1);
        context.fillStyle = line.complete ? options.foreground : options.accent;
        context.shadowColor = options.accent;
        context.shadowBlur = motion.glow;
        context.translate(tokenX + motion.x, baseY + flowOffset(token.arrivedAt, now, options.reducedMotion) + motion.y);
        context.rotate(motion.rotation * Math.PI / 180);
        context.scale(motion.scaleX, motion.scaleY);
        context.fillText(token.text, 0, 0);
        context.restore();
        tokenX += context.measureText(token.text).width + motion.tracking;
      }
    }

    if (!this.#pinned) {
      context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillStyle = options.accent;
      context.fillText("JUMP TO LATEST", rect.x + padding, rect.y + rect.height - 8);
    }
    const maxScroll = this.#maxScroll();
    if (maxScroll > 0) {
      const trackHeight = Math.max(20, rect.height - padding * 2);
      const thumbHeight = Math.max(24, trackHeight * (this.#viewportHeight / (allLines.length * this.#lineHeight)));
      const thumbY = rect.y + padding + (trackHeight - thumbHeight) * (this.#scrollTop / maxScroll);
      context.fillStyle = options.muted;
      context.fillRect(rect.x + rect.width - 3, thumbY, 1, thumbHeight);
    }
    context.restore();
  }

  #layoutPending(arrivedAt: number, complete: boolean): void {
    const text = this.#tail + this.#pending;
    if (!text) return;
    const shaped = this.layout.lines(text, this.#width);
    if (shaped.length === 0) return;
    const ranges = lineRanges(text, shaped.map((line) => line.text));
    const commitCount = complete ? shaped.length : Math.max(0, shaped.length - 1);
    for (let index = 0; index < commitCount; index += 1) {
      const line = shaped[index];
      const range = ranges[index];
      if (!line) continue;
      const start = this.#activeStart + (range?.start ?? 0);
      const end = this.#activeStart + (range?.end ?? line.text.length);
      const tokens = tokensForRange(this.#currentChunks, start, end, line.text, arrivedAt);
      this.#lines.push({
        id: this.#nextLineId++,
        text: line.text,
        width: line.width,
        arrivedAt: tokens[0]?.arrivedAt ?? arrivedAt,
        complete: true,
        tokens,
      });
    }
    if (complete) {
      this.#tail = "";
    } else {
      const lastText = shaped.at(-1)?.text ?? text;
      const lastStart = ranges.at(-1)?.start ?? text.lastIndexOf(lastText);
      this.#tail = lastStart >= 0 ? text.slice(lastStart) : lastText;
      if (lastStart >= 0) this.#activeStart += lastStart;
    }
    this.#pending = "";
    this.#syncPinned();
  }

  #reflowAll(): void {
    const wasPinned = this.#pinned;
    this.#lines = [];
    this.#tail = "";
    for (const utterance of this.#utterances) {
      const shaped = this.layout.lines(utterance.text, this.#width);
      const ranges = lineRanges(utterance.text, shaped.map((line) => line.text));
      for (let index = 0; index < shaped.length; index += 1) {
        const line = shaped[index];
        const range = ranges[index];
        if (!line) continue;
        const tokens = tokensForRange(utterance.chunks, range?.start ?? 0, range?.end ?? line.text.length, line.text, utterance.startedAt);
        this.#lines.push({
          id: this.#nextLineId++,
          text: line.text,
          width: line.width,
          arrivedAt: tokens[0]?.arrivedAt ?? utterance.startedAt,
          complete: true,
          tokens,
        });
      }
    }
    if (this.#currentText) {
      const shaped = this.layout.lines(this.#currentText, this.#width);
      const ranges = lineRanges(this.#currentText, shaped.map((line) => line.text));
      for (let index = 0; index < Math.max(0, shaped.length - 1); index += 1) {
        const line = shaped[index];
        const range = ranges[index];
        if (!line) continue;
        const tokens = tokensForRange(this.#currentChunks, range?.start ?? 0, range?.end ?? line.text.length, line.text, this.#currentStartedAt);
        this.#lines.push({
          id: this.#nextLineId++,
          text: line.text,
          width: line.width,
          arrivedAt: tokens[0]?.arrivedAt ?? this.#currentStartedAt,
          complete: true,
          tokens,
        });
      }
      const lastText = shaped.at(-1)?.text ?? this.#currentText;
      const lastStart = ranges.at(-1)?.start ?? this.#currentText.lastIndexOf(lastText);
      this.#tail = lastStart >= 0 ? this.#currentText.slice(lastStart) : lastText;
      this.#activeStart = Math.max(0, lastStart);
    }
    this.#pending = "";
    this.#pinned = wasPinned;
    this.#syncPinned();
  }

  #maxScroll(): number {
    return Math.max(0, this.lines.length * this.#lineHeight - this.#viewportHeight);
  }

  #syncPinned(): void {
    if (this.#pinned) this.#scrollTop = this.#maxScroll();
    else this.#scrollTop = Math.min(this.#scrollTop, this.#maxScroll());
  }
}

function lineRanges(source: string, lines: readonly string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const line of lines) {
    const located = source.indexOf(line, cursor);
    const start = located >= 0 ? located : cursor;
    const end = Math.min(source.length, start + line.length);
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}

function tokensForRange(chunks: readonly TimedChunk[], start: number, end: number, fallbackText: string, fallbackArrivedAt: number): PanelToken[] {
  const tokens: PanelToken[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const chunkStart = cursor;
    const chunkEnd = cursor + chunk.text.length;
    const overlapStart = Math.max(start, chunkStart);
    const overlapEnd = Math.min(end, chunkEnd);
    if (overlapStart < overlapEnd) {
      tokens.push({ text: chunk.text.slice(overlapStart - chunkStart, overlapEnd - chunkStart), arrivedAt: chunk.arrivedAt });
    }
    cursor = chunkEnd;
    if (cursor >= end) break;
  }
  return tokens.length > 0 ? tokens : [{ text: fallbackText, arrivedAt: fallbackArrivedAt }];
}
