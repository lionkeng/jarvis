import { clearCache, layoutNextLine, prepareWithSegments, setLocale, type LayoutCursor, type LayoutLine } from "@chenglou/pretext";

export interface TextLayoutOptions {
  locale?: string;
  letterSpacing?: number;
}

export class PretextLayout {
  #font: string;
  #options: TextLayoutOptions;
  #prepareCount = 0;

  constructor(font = "500 18px ui-monospace, SFMono-Regular, Menlo, monospace", options: TextLayoutOptions = {}) {
    this.#font = font;
    this.#options = options;
    if (options.locale) setLocale(options.locale);
  }

  get font(): string {
    return this.#font;
  }

  get prepareCount(): number {
    return this.#prepareCount;
  }

  setFont(font: string): void {
    this.#font = font;
  }

  clear(): void {
    clearCache();
  }

  lines(text: string, maxWidth: number): LayoutLine[] {
    if (!text || maxWidth <= 0) return [];
    this.#prepareCount += 1;
    const options = this.#options.letterSpacing === undefined ? undefined : { letterSpacing: this.#options.letterSpacing };
    const prepared = prepareWithSegments(text, this.#font, options);
    const lines: LayoutLine[] = [];
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    while (true) {
      const line = layoutNextLine(prepared, cursor, maxWidth);
      if (!line) break;
      lines.push(line);
      if (line.end.segmentIndex === cursor.segmentIndex && line.end.graphemeIndex === cursor.graphemeIndex) break;
      cursor = line.end;
    }
    return lines;
  }
}
