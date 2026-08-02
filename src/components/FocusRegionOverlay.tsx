import type { CSSProperties } from "react";
import type { FocusRegionPosition } from "@/lib/focusPoint";

interface FocusRegionOverlayProps {
  position: FocusRegionPosition;
}

export function FocusRegionOverlay({ position }: FocusRegionOverlayProps) {
  const style: CSSProperties = {
    left: `${position.left}%`,
    top: `${position.top}%`,
    width: `${position.width}%`,
    height: `${position.height}%`,
  };

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute z-10 block min-h-2 min-w-2 rounded-sm border-2 border-cyan-300 shadow-[0_0_0_1px_rgba(0,0,0,0.9),0_0_5px_rgba(0,0,0,0.65)]"
      style={style}
    />
  );
}
