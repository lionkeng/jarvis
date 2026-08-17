export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha))})`;
}

export function paletteColor(palette: readonly string[], index: number, fallback = "#ffffff"): string {
  if (palette.length === 0) return fallback;
  return palette[((index % palette.length) + palette.length) % palette.length] ?? fallback;
}
