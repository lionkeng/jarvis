import type { VisualizationPreset } from "../types.js";
import { paletteColor, withAlpha } from "../color.js";

export const waveformPreset: VisualizationPreset = {
  name: "waveform",
  layer: 20,
  paint({ context, regions, features, theme }) {
    const rect = regions.viz;
    const values = features.waveformData;
    if (values.length === 0) return;
    context.beginPath();
    for (let index = 0; index < values.length; index += 1) {
      const x = rect.x + index / Math.max(values.length - 1, 1) * rect.width;
      const y = rect.y + rect.height * 0.5 + ((values[index] ?? 128) - 128) / 128 * rect.height * 0.36 * theme.scale;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = withAlpha(paletteColor(theme.palette, 1, theme.foreground), 0.44);
    context.lineWidth = (1 + features.level * 3) * theme.strokeWeight;
    context.stroke();
  },
};
