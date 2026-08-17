export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PanelPlacement = "bottom" | "side" | "auto";

export interface Regions {
  viz: Rect;
  panel: Rect;
  placement: Exclude<PanelPlacement, "auto">;
}
