// The library carries declarative UI layouts, never arbitrary uploaded scripts.
export type UiDimension = { xScale: number; xOffset: number; yScale: number; yOffset: number };
export type UiNode = {
  id: string; parentId: string | null;
  className: "Frame" | "TextLabel" | "TextButton" | "ImageLabel" | "ImageButton";
  name: string; position: UiDimension; size: UiDimension;
  anchorPoint: { x: number; y: number };
  backgroundColor: [number, number, number]; backgroundTransparency: number;
  zIndex: number; cornerRadius?: number;
  text?: string; textColor?: [number, number, number]; textSize?: number;
  imageKey?: string;
};
export type UiLayout = { version: 1; name: string; nodes: UiNode[] };
