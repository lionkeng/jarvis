const CJK_TEXT = /[\p{Script=Han}\p{Script=Bopomofo}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function firstGrapheme(text: string): string | undefined {
  if (!text) return undefined;
  if (graphemeSegmenter) {
    const first = graphemeSegmenter.segment(text)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment;
  }
  return Array.from(text)[0];
}

export function containsCjkText(text: string): boolean {
  return CJK_TEXT.test(text);
}

export function isCjkGrapheme(grapheme: string): boolean {
  return CJK_TEXT.test(grapheme);
}

export function containsAtLeastGraphemes(text: string, minimum: number): boolean {
  if (minimum <= 0) return true;
  let count = 0;
  const segments: Iterable<unknown> = graphemeSegmenter?.segment(text) ?? Array.from(text);
  for (const _segment of segments) {
    count += 1;
    if (count >= minimum) return true;
  }
  return false;
}
