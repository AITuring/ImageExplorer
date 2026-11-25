import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { getFileDragIcon, startNativeFileDrag } from "@/lib/dragData";

const DRAG_START_DISTANCE_PX = 10;
const INTERACTIVE_TARGET_SELECTOR =
  'button, input, select, textarea, [contenteditable="true"], [role="button"], [data-context-menu-content]';

interface PointerStart {
  id: number;
  x: number;
  y: number;
}

interface NativeDragGestureState {
  pointerStart: PointerStart;
  nativeDragStarted: boolean;
}

// File rows can rerender while metadata or thumbnails load. Keeping gesture
// state on the DOM node prevents a rerender from discarding an in-progress
// pointer gesture.
const nativeDragGestureStates = new WeakMap<HTMLElement, NativeDragGestureState>();

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
export function makeNativeFileDragGestureHandlers(
  paths: string[],
  options?: { allowButtonTarget?: boolean }
) {
  const resetPointer = (element: HTMLElement, pointerId: number) => {
    const gesture = nativeDragGestureStates.get(element);
    if (!gesture || gesture.pointerStart.id !== pointerId) return;
    nativeDragGestureStates.delete(element);
  };

  return {
    draggable: false as const,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      if (!options?.allowButtonTarget) {
        if ((event.target as Element).closest(INTERACTIVE_TARGET_SELECTOR)) return;
      } else if (
        (event.target as Element).closest(
          'input, select, textarea, [contenteditable="true"], [data-context-menu-content]'
        )
      ) {
        return;
      }

      nativeDragGestureStates.set(event.currentTarget, {
        pointerStart: {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        },
        nativeDragStarted: false,
      });
      // Do not capture the pointer while this is still an ordinary click.
      // WebKit needs the untouched down/up sequence to recognize double-clicks.
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = nativeDragGestureStates.get(event.currentTarget);
      if (!gesture || gesture.pointerStart.id !== event.pointerId || gesture.nativeDragStarted) {
        return;
      }
      if ((event.buttons & 1) === 0) {
        resetPointer(event.currentTarget, event.pointerId);
        return;
      }
      if (
        !hasReachedNativeDragThreshold(
          gesture.pointerStart.x,
          gesture.pointerStart.y,
          event.clientX,
          event.clientY
        )
      ) {
        return;
      }

      gesture.nativeDragStarted = true;
      const element = event.currentTarget;
      event.preventDefault();

      const icon = getFileDragIcon(element);
      void startNativeFileDrag(paths, icon).catch((error) => {
        nativeDragGestureStates.delete(element);
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

interface DelegatedDragState extends NativeDragGestureState {
  itemElement: HTMLElement;
  path: string;
}

const delegatedDragStates = new WeakMap<HTMLElement, DelegatedDragState>();

/**
 * Container-level delegated version of `makeNativeFileDragGestureHandlers` so
 * virtualized lists/grids do not allocate 5 fresh pointer/drag closures per
 * visible cell on every render.
 */
export function makeDelegatedFileDragGestureHandlers(
  resolvePathsForEntry: (entryPath: string) => string[]
) {
  const resetPointer = (container: HTMLElement, pointerId: number) => {
    const gesture = delegatedDragStates.get(container);
    if (!gesture || gesture.pointerStart.id !== pointerId) return;
    delegatedDragStates.delete(container);
  };

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target || target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
      const itemElement = target.closest<HTMLElement>("[data-entry-path]");
      const path = itemElement?.dataset.entryPath;
      if (!itemElement || !path) return;

      delegatedDragStates.set(event.currentTarget, {
        itemElement,
        path,
        pointerStart: {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        },
        nativeDragStarted: false,
      });
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const container = event.currentTarget;
      const gesture = delegatedDragStates.get(container);
      if (!gesture || gesture.pointerStart.id !== event.pointerId || gesture.nativeDragStarted) {
        return;
      }
      if ((event.buttons & 1) === 0) {
        resetPointer(container, event.pointerId);
        return;
      }
      if (
        !hasReachedNativeDragThreshold(
          gesture.pointerStart.x,
          gesture.pointerStart.y,
          event.clientX,
          event.clientY
        )
      ) {
        return;
      }

      gesture.nativeDragStarted = true;
      event.preventDefault();
      const paths = resolvePathsForEntry(gesture.path);
      const icon = getFileDragIcon(gesture.itemElement);
      void startNativeFileDrag(paths, icon).catch((error) => {
        delegatedDragStates.delete(container);
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
      const target = event.target as Element | null;
      if (target?.closest("[data-entry-path]")) {
        event.preventDefault();
      }
    },
  };
}
