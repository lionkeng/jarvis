import type { PanelPlacement, Rect, Regions } from "./types.js";

export interface RegionOptions {
  placement?: PanelPlacement;
  breakpoint?: number;
  gap?: number;
  inset?: number;
}

function clampRect(rect: Rect): Rect {
  return {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}

export function computeRegions(width: number, height: number, options: RegionOptions = {}): Regions {
  const inset = Math.min(options.inset ?? 16, width * 0.05, height * 0.05);
  const gap = options.gap ?? 12;
  const breakpoint = options.breakpoint ?? 640;
  const requested = options.placement ?? "auto";
  const placement = requested === "auto" ? (width >= breakpoint && width / Math.max(height, 1) >= 1.2 ? "side" : "bottom") : requested;
  const contentWidth = Math.max(0, width - inset * 2);
  const contentHeight = Math.max(0, height - inset * 2);

  if (placement === "side") {
    const panelWidth = Math.min(contentWidth, 420, Math.max(240, contentWidth * 0.36));
    return {
      placement,
      viz: clampRect({ x: inset, y: inset, width: contentWidth - panelWidth - gap, height: contentHeight }),
      panel: clampRect({ x: inset + contentWidth - panelWidth, y: inset, width: panelWidth, height: contentHeight }),
    };
  }

  const panelHeight = Math.min(contentHeight, 260, Math.max(116, contentHeight * 0.34));
  return {
    placement,
    viz: clampRect({ x: inset, y: inset, width: contentWidth, height: contentHeight - panelHeight - gap }),
    panel: clampRect({ x: inset, y: inset + contentHeight - panelHeight, width: contentWidth, height: panelHeight }),
  };
}
