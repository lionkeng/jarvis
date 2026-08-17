import type { VisualizationPreset } from "../types.js";
import { paletteColor, withAlpha } from "../color.js";

export const barsPreset: VisualizationPreset = {
  name: "bars",
  layer: 10,
  paint({ context, regions, features, theme, state }) {
    const rect = regions.viz;
    const values = features.frequencyData;
    if (values.length === 0) return;
    const count = Math.min(Math.max(1, Math.round(64 * theme.density)), values.length);
    const barWidth = rect.width / count;
    const baseline = rect.y + rect.height;
    for (let index = 0; index < count; index += 1) {
      const binStart = Math.floor(index / count * values.length);
      const binEnd = Math.max(binStart + 1, Math.floor((index + 1) / count * values.length));
      let sum = 0;
      for (let bin = binStart; bin < Math.min(binEnd, values.length); bin += 1) sum += values[bin] ?? 0;
      const amount = sum / (Math.max(1, binEnd - binStart) * 255);
      const height = Math.max(1, amount * rect.height * 0.42 * theme.scale);
      const x = rect.x + index * barWidth;
      const color = paletteColor(theme.palette, index, theme.accent);
      const activeAlpha = state === "speaking" ? 0.68 : 0.3;
      const gradient = context.createLinearGradient(x, baseline, x, baseline - height);
      gradient.addColorStop(0, withAlpha(color, activeAlpha));
      gradient.addColorStop(1, withAlpha(color, 0.05));
      context.fillStyle = gradient;
      context.fillRect(x, baseline - height, Math.max(1, barWidth - 1), height);

      const mirrorHeight = height * 0.3;
      const mirror = context.createLinearGradient(x, rect.y, x, rect.y + mirrorHeight);
      mirror.addColorStop(0, withAlpha(color, 0.16));
      mirror.addColorStop(1, withAlpha(color, 0));
      context.fillStyle = mirror;
      context.fillRect(x, rect.y, Math.max(1, barWidth - 1), mirrorHeight);
    }
  },
};
