import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { getFileDragIcon, startNativeFileDrag } from "@/lib/dragData";

const DRAG_START_DISTANCE_PX = 5;
const INTERACTIVE_TARGET_SELECTOR =
  'button, input, select, textarea, [contenteditable="true"], [role="button"]';

interface PointerStart {
  id: number;
  x: number;
  y: number;
}

export function hasReachedNativeDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number
) {
  return Math.hypot(currentX - startX, currentY - startY) >= DRAG_START_DISTANCE_PX;
}

/**
 * Start the OS drag before WebKit creates its own rendered-card drag. Waiting
 * for `dragstart` is too late because WebKit already owns the mouse gesture.
 */
export function makeNativeFileDragGestureHandlers(paths: string[]) {
  let pointerStart: PointerStart | null = null;
  let nativeDragStarted = false;

  const releasePointer = (element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };

  const resetPointer = (element: HTMLElement, pointerId: number) => {
    releasePointer(element, pointerId);
    pointerStart = null;
    nativeDragStarted = false;
  };

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      if ((event.target as Element).closest(INTERACTIVE_TARGET_SELECTOR)) return;

      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      nativeDragStarted = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (!pointerStart || pointerStart.id !== event.pointerId || nativeDragStarted) return;
      if ((event.buttons & 1) === 0) {
        resetPointer(event.currentTarget, event.pointerId);
        return;
      }
      if (
        !hasReachedNativeDragThreshold(pointerStart.x, pointerStart.y, event.clientX, event.clientY)
      ) {
        return;
      }

      nativeDragStarted = true;
      pointerStart = null;
      releasePointer(event.currentTarget, event.pointerId);
      event.preventDefault();

      const icon = getFileDragIcon(event.currentTarget);
      void startNativeFileDrag(paths, icon).catch((error) => {
        nativeDragStarted = false;
        console.error("Failed to start native file drag", error);
      });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      resetPointer(event.currentTarget, event.pointerId);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      resetPointer(event.currentTarget, event.pointerId);
    },
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
    },
  };
}
