import type { CSSProperties } from "react";
import type { FocusPoint } from "@/lib/photoAnalysis";
import type { FocusPointPosition } from "@/lib/focusPoint";

interface FocusPointOverlayProps {
  point: FocusPoint | null | undefined;
  position: FocusPointPosition;
  inverseScale?: number;
}

export function FocusPointOverlay({ point, position, inverseScale = 1 }: FocusPointOverlayProps) {
  if (!point) return null;

  const style: CSSProperties = {
    left: `${position.left}%`,
    top: `${position.top}%`,
    transform: `translate(-50%, -50%) scale(${inverseScale})`,
  };

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute z-10 block h-4 w-4 rounded-full border-2 border-cyan-400 shadow-[0_0_0_1px_rgba(0,0,0,0.9),0_0_5px_rgba(0,0,0,0.65)]"
      style={style}
    />
  );
}
