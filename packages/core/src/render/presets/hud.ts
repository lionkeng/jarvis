import type { VisualizationPreset } from "../types.js";
import { paletteColor, withAlpha } from "../color.js";

export const hudPreset: VisualizationPreset = {
  name: "hud",
  layer: 50,
  paint({ context, regions, theme, state, stateAge, now, reducedMotion, features }) {
    const rect = regions.viz;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) * 0.31 * theme.scale;
    context.strokeStyle = withAlpha(theme.muted, 0.28);
    context.lineWidth = theme.strokeWeight;
    for (let ring = 1; ring <= 3; ring += 1) {
      const rotation = reducedMotion ? -Math.PI / 2 : now * 0.00018 * (ring % 2 === 0 ? -1 : 1) + stateAge * 0.08;
      context.beginPath();
      context.arc(cx, cy, radius * ring / 3, rotation, rotation + Math.PI * (1.18 + ring * 0.17));
      context.stroke();
    }
    const tickCount = Math.max(16, Math.round(48 * theme.density));
    for (let index = 0; index < tickCount; index += 1) {
      const angle = index / tickCount * Math.PI * 2;
      const inner = radius + (index % 4 === 0 ? 7 : 3);
      context.beginPath();
      context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      context.lineTo(cx + Math.cos(angle) * (radius + 11), cy + Math.sin(angle) * (radius + 11));
      context.stroke();
    }
    const scan = reducedMotion ? 0.5 : (Math.sin(now * 0.0014) + 1) / 2;
    const flicker = reducedMotion ? 1 : 0.86 + Math.sin(now * 0.037) * 0.14;
    context.strokeStyle = withAlpha(paletteColor(theme.palette, 4, theme.accent), (0.12 + features.level * 0.2) * flicker);
    context.beginPath();
    context.moveTo(rect.x, rect.y + rect.height * scan);
    context.lineTo(rect.x + rect.width, rect.y + rect.height * scan);
    context.stroke();
    context.fillStyle = theme.muted;
    context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(state.toUpperCase(), rect.x + 8, rect.y + 14);
  },
};
