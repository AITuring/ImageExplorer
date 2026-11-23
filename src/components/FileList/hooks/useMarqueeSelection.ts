import { useCallback, useEffect, useRef, useState } from "react";

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface UseMarqueeSelectionOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  selectedPaths: string[];
  onSelectPaths: (paths: string[]) => void;
  onClearSelection: () => void;
}

const DRAG_THRESHOLD_PX = 4;

/**
 * Finder-style rubber-band marquee selection for scrollable icon/list containers.
 * Supports Cmd/Shift additive selection and works seamlessly with virtualized items
 * marked with `data-marquee-path`.
 */
export function useMarqueeSelection({
  containerRef,
  enabled,
  selectedPaths,
  onSelectPaths,
  onClearSelection,
}: UseMarqueeSelectionOptions) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const selectedPathsRef = useRef(selectedPaths);
  const onSelectPathsRef = useRef(onSelectPaths);
  const onClearSelectionRef = useRef(onClearSelection);

  useEffect(() => {
    selectedPathsRef.current = selectedPaths;
    onSelectPathsRef.current = onSelectPaths;
    onClearSelectionRef.current = onClearSelection;
  });

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!enabled || event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          '[data-marquee-item="true"], input, button, textarea, select, [role="button"]'
        )
      ) {
        return;
      }

      const rect = container.getBoundingClientRect();
      // Ignore clicks on the native vertical/horizontal scrollbar track.
      if (
        event.clientX > rect.left + container.clientWidth ||
        event.clientY > rect.top + container.clientHeight
      ) {
        return;
      }

      const additive = event.metaKey || event.ctrlKey || event.shiftKey;
      const baseSelection = additive ? selectedPathsRef.current.slice() : [];
      const startContentX = event.clientX - rect.left + container.scrollLeft;
      const startContentY = event.clientY - rect.top + container.scrollTop;
      let startedDragging = false;
      let rafId = 0;
      let latestClientX = event.clientX;
      let latestClientY = event.clientY;

      const updateSelection = () => {
        rafId = 0;
        const containerRect = container.getBoundingClientRect();
        const currentContentX = latestClientX - containerRect.left + container.scrollLeft;
        const currentContentY = latestClientY - containerRect.top + container.scrollTop;

        const left = Math.min(startContentX, currentContentX);
        const top = Math.min(startContentY, currentContentY);
        const width = Math.abs(currentContentX - startContentX);
        const height = Math.abs(currentContentY - startContentY);

        if (!startedDragging && width < DRAG_THRESHOLD_PX && height < DRAG_THRESHOLD_PX) {
          return;
        }
        startedDragging = true;
        setMarqueeRect({ left, top, width, height });

        // Compute marquee box in viewport coordinates to test against mounted items.
        const viewLeft = left - container.scrollLeft + containerRect.left;
        const viewTop = top - container.scrollTop + containerRect.top;
        const viewRight = viewLeft + width;
        const viewBottom = viewTop + height;

        const hitPaths: string[] = [];
        const nodes = container.querySelectorAll<HTMLElement>("[data-marquee-path]");
        for (const node of nodes) {
          const itemRect = node.getBoundingClientRect();
          const intersects =
            itemRect.right >= viewLeft &&
            itemRect.left <= viewRight &&
            itemRect.bottom >= viewTop &&
            itemRect.top <= viewBottom;
          if (intersects) {
            const path = node.dataset.marqueePath;
            if (path) hitPaths.push(path);
          }
        }

        const nextPaths = additive ? [...baseSelection, ...hitPaths] : hitPaths;
        onSelectPathsRef.current(nextPaths);
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        latestClientX = moveEvent.clientX;
        latestClientY = moveEvent.clientY;
        if (rafId === 0) {
          rafId = window.requestAnimationFrame(updateSelection);
        }
      };

      const handleMouseUp = () => {
        if (rafId !== 0) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        if (startedDragging) {
          setMarqueeRect(null);
        } else if (!additive && selectedPathsRef.current.length > 0) {
          onClearSelectionRef.current();
        }
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [containerRef, enabled]
  );

  return {
    marqueeRect,
    handleMarqueeMouseDown: handleMouseDown,
  };
}
