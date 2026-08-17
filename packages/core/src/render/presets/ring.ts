import type { VisualizationPreset } from "../types.js";
import { paletteColor, withAlpha } from "../color.js";

export const ringPreset: VisualizationPreset = {
  name: "ring",
  layer: 30,
  paint({ context, regions, features, theme, state, now, reducedMotion }) {
    const rect = regions.viz;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const base = Math.min(rect.width, rect.height) * 0.19 * theme.scale;
    const radius = base * (1 + features.level * 0.52 + (reducedMotion ? 0 : Math.sin(now * 0.0018) * 0.015));
    const values = features.frequencyData;
    const segments = Math.max(32, Math.round(128 * theme.density));
    context.beginPath();
    for (let index = 0; index <= segments; index += 1) {
      const normalizedIndex = index % segments;
      const binStart = Math.floor(normalizedIndex / segments * values.length);
      const binEnd = Math.max(binStart + 1, Math.floor((normalizedIndex + 1) / segments * values.length));
      let sum = 0;
      for (let bin = binStart; bin < Math.min(binEnd, values.length); bin += 1) sum += values[bin] ?? 0;
      const energy = sum / (Math.max(1, binEnd - binStart) * 255);
      const angle = index / segments * Math.PI * 2 - Math.PI / 2;
      const r = radius + energy * base * 0.48;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.strokeStyle = withAlpha(paletteColor(theme.palette, 2, theme.accent), state === "speaking" ? 0.92 : 0.48);
    context.lineWidth = (1.4 + features.onset * 2) * theme.strokeWeight;
    context.stroke();
    context.beginPath();
    context.arc(cx, cy, radius * 0.62, 0, Math.PI * 2);
    context.strokeStyle = withAlpha(paletteColor(theme.palette, 3, theme.foreground), features.voiced ? 0.4 : 0.16);
    context.lineWidth = theme.strokeWeight;
    context.stroke();
    const pulseRadius = base * (0.62 + features.level * 0.5);
    const pulse = context.createRadialGradient(cx, cy, 0, cx, cy, pulseRadius);
    const pulseColor = paletteColor(theme.palette, 3, theme.accent);
    pulse.addColorStop(0, withAlpha(pulseColor, 0.12 + features.level * 0.18));
    pulse.addColorStop(1, withAlpha(pulseColor, 0));
    context.fillStyle = pulse;
    context.beginPath();
    context.arc(cx, cy, pulseRadius, 0, Math.PI * 2);
    context.fill();
  },
};
