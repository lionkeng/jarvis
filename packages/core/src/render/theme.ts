export type TextMotion = "flow" | "kinetic";

export interface Theme {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  accent: string;
  palette: readonly string[];
  trailOpacity: number;
  paletteMode: "fixed" | "cycle" | "state";
  textMotion: TextMotion;
  density: number;
  strokeWeight: number;
  scale: number;
}

export const themes = {
  cyan: {
    background: "#070b0d",
    surface: "#0d1417",
    foreground: "#d5e2e5",
    muted: "#70858b",
    accent: "#66d9d0",
    palette: ["#66d9d0", "#d5e2e5", "#e2a84a", "#4c8d96", "#9fe8df"],
    trailOpacity: 0.22,
    paletteMode: "fixed",
    textMotion: "flow",
    density: 1,
    strokeWeight: 1,
    scale: 1,
  },
  amber: {
    background: "#0b0906",
    surface: "#15110a",
    foreground: "#e8dfcf",
    muted: "#8f8069",
    accent: "#e2a84a",
    palette: ["#e2a84a", "#f1c66f", "#d47e3a", "#f0dfbd", "#9d6a2d"],
    trailOpacity: 0.24,
    paletteMode: "fixed",
    textMotion: "flow",
    density: 1,
    strokeWeight: 1,
    scale: 1,
  },
  rose: {
    background: "#0c080a",
    surface: "#170e12",
    foreground: "#e7d9df",
    muted: "#8f747e",
    accent: "#d86f8f",
    palette: ["#d86f8f", "#ef9eb7", "#9c4f73", "#e7d9df", "#713650"],
    trailOpacity: 0.22,
    paletteMode: "fixed",
    textMotion: "flow",
    density: 1,
    strokeWeight: 1,
    scale: 1,
  },
  spectrum: {
    background: "#0b080d", surface: "#150e18", foreground: "#f2e8f0", muted: "#927d91", accent: "#ff006e",
    palette: ["#ff006e", "#fb5607", "#ffbe0b", "#8338ec", "#3a86ff"], trailOpacity: 0.2, paletteMode: "fixed", textMotion: "flow", density: 1, strokeWeight: 1, scale: 1,
  },
  coast: {
    background: "#061012", surface: "#0a1a1d", foreground: "#e5f0ed", muted: "#718c8b", accent: "#06d6a0",
    palette: ["#06d6a0", "#118ab2", "#073b4c", "#ef476f", "#ffd166"], trailOpacity: 0.2, paletteMode: "fixed", textMotion: "flow", density: 1, strokeWeight: 1, scale: 1,
  },
  ultraviolet: {
    background: "#090815", surface: "#121126", foreground: "#ebe9f8", muted: "#807b9e", accent: "#7400b8",
    palette: ["#7400b8", "#6930c3", "#5390d9", "#4ea8de", "#48bfe3"], trailOpacity: 0.2, paletteMode: "fixed", textMotion: "flow", density: 1, strokeWeight: 1, scale: 1,
  },
  magenta: {
    background: "#0d0611", surface: "#190b20", foreground: "#f2e8f5", muted: "#94799b", accent: "#f72585",
    palette: ["#f72585", "#b5179e", "#7209b7", "#560bad", "#480ca8"], trailOpacity: 0.2, paletteMode: "fixed", textMotion: "flow", density: 1, strokeWeight: 1, scale: 1,
  },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof themes;

export type ThemeInput = ThemeName | Partial<Theme>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function resolveTheme(theme: ThemeInput | undefined): Theme {
  if (!theme) return themes.cyan;
  if (typeof theme === "string") return themes[theme];
  const palette = theme.palette?.length ? theme.palette : theme.accent ? [theme.accent, ...themes.cyan.palette.slice(1)] : themes.cyan.palette;
  return {
    ...themes.cyan,
    ...theme,
    palette,
    trailOpacity: clamp(theme.trailOpacity ?? themes.cyan.trailOpacity, 0.02, 1),
    density: clamp(theme.density ?? themes.cyan.density, 0.25, 2),
    strokeWeight: clamp(theme.strokeWeight ?? themes.cyan.strokeWeight, 0.5, 3),
    scale: clamp(theme.scale ?? themes.cyan.scale, 0.5, 1.8),
  };
}

export function themeForFrame(theme: Theme, state: string, now: number): Theme {
  if (theme.paletteMode === "fixed") return theme;
  if (theme.paletteMode === "cycle") {
    const sequence = [themes.cyan, themes.amber, themes.rose] as const;
    const palette = sequence[Math.floor(now / 15_000) % sequence.length] ?? themes.cyan;
    return { ...theme, background: palette.background, surface: palette.surface, foreground: palette.foreground, muted: palette.muted, accent: palette.accent, palette: palette.palette };
  }
  const palette = state === "thinking" ? themes.amber : state === "interrupted" || state === "error" ? themes.rose : themes.cyan;
  return { ...theme, background: palette.background, surface: palette.surface, foreground: palette.foreground, muted: palette.muted, accent: palette.accent, palette: palette.palette };
}
