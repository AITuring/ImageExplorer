import {
  memo,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  normalizedRectFromPoints,
  type NormalizedRect,
  type SharpnessMaskResult,
} from "@/lib/sharpnessAnalysis";

interface SharpnessSelectionOverlayProps {
  enabled: boolean;
  selectionMode: boolean;
  selection: NormalizedRect | null;
  result: SharpnessMaskResult | null;
  onSelectionCommit: (selection: NormalizedRect) => void;
  onSelectionTooSmall: () => void;
  onAnalyzeFullImage: () => void;
  onEscape: () => void;
}

const MIN_SELECTION_SIZE_PX = 24;
const POINT_CLICK_THRESHOLD_PX = 8;
const POINT_CLICK_BOX_SPAN = 0.24;
const FULL_IMAGE_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

function selectionStyle(selection: NormalizedRect): CSSProperties {
  return {
    left: `${selection.x * 100}%`,
    top: `${selection.y * 100}%`,
    width: `${selection.width * 100}%`,
    height: `${selection.height * 100}%`,
  };
}

function pointClickSelection(point: { x: number; y: number }): NormalizedRect {
  const half = POINT_CLICK_BOX_SPAN / 2;
  const x = Math.min(1 - POINT_CLICK_BOX_SPAN, Math.max(0, point.x - half));
  const y = Math.min(1 - POINT_CLICK_BOX_SPAN, Math.max(0, point.y - half));
  return { x, y, width: POINT_CLICK_BOX_SPAN, height: POINT_CLICK_BOX_SPAN };
}

export const SharpnessSelectionOverlay = memo(function SharpnessSelectionOverlay({
  enabled,
  selectionMode,
  selection,
  result,
  onSelectionCommit,
  onSelectionTooSmall,
  onAnalyzeFullImage,
  onEscape,
}: SharpnessSelectionOverlayProps) {
  const { t } = useTranslation();
  const selectionStartRef = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const dragBoundsRef = useRef<DOMRect | null>(null);
  const draftSelectionRef = useRef<NormalizedRect | null>(null);
  const draftFrameRef = useRef<number | null>(null);
  const draftBoxRef = useRef<HTMLSpanElement | null>(null);
  const committedBoxRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, result.width, result.height);
    context.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  }, [result]);

  useEffect(() => {
    return () => {
      if (draftFrameRef.current !== null) {
        window.cancelAnimationFrame(draftFrameRef.current);
      }
    };
  }, []);

  if (!enabled) return null;

  const pointFromBounds = (clientX: number, clientY: number, bounds: DOMRect) => ({
    x: (clientX - bounds.left) / Math.max(bounds.width, 1),
    y: (clientY - bounds.top) / Math.max(bounds.height, 1),
  });

  const paintDraftBox = (rect: NormalizedRect | null) => {
    const box = draftBoxRef.current;
    if (!box) return;
    if (!rect) {
      box.style.display = "none";
      if (committedBoxRef.current) {
        committedBoxRef.current.style.visibility = "";
      }
      return;
    }
    if (committedBoxRef.current) {
      committedBoxRef.current.style.visibility = "hidden";
    }
    box.style.display = "block";
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.width * 100}%`;
    box.style.height = `${rect.height * 100}%`;
  };

  const publishDraft = (nextSelection: NormalizedRect) => {
    draftSelectionRef.current = nextSelection;
    if (draftFrameRef.current !== null) return;
    draftFrameRef.current = window.requestAnimationFrame(() => {
      draftFrameRef.current = null;
      paintDraftBox(draftSelectionRef.current);
    });
  };

  const clearDraft = () => {
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    selectionStartRef.current = null;
    dragBoundsRef.current = null;
    draftSelectionRef.current = null;
    paintDraftBox(null);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    dragBoundsRef.current = bounds;
    const startPoint = pointFromBounds(event.clientX, event.clientY, bounds);
    selectionStartRef.current = {
      ...startPoint,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    const initialRect = normalizedRectFromPoints(startPoint, startPoint);
    draftSelectionRef.current = initialRect;
    paintDraftBox(initialRect);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    const bounds = dragBoundsRef.current;
    if (!start || !bounds || !event.isPrimary) return;
    event.preventDefault();
    publishDraft(
      normalizedRectFromPoints(start, pointFromBounds(event.clientX, event.clientY, bounds))
    );
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    const bounds = dragBoundsRef.current ?? event.currentTarget.getBoundingClientRect();
    if (!start || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    const endPoint = pointFromBounds(event.clientX, event.clientY, bounds);
    const nextSelection = normalizedRectFromPoints(start, endPoint);
    const dragDx = Math.abs(event.clientX - start.clientX);
    const dragDy = Math.abs(event.clientY - start.clientY);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearDraft();

    // A quick click (点选) inspects a centered patch around the clicked point
    // immediately instead of failing with a "too small" error.
    if (dragDx <= POINT_CLICK_THRESHOLD_PX && dragDy <= POINT_CLICK_THRESHOLD_PX) {
      onSelectionCommit(pointClickSelection(endPoint));
      return;
    }

    if (
      nextSelection.width * bounds.width < MIN_SELECTION_SIZE_PX ||
      nextSelection.height * bounds.height < MIN_SELECTION_SIZE_PX
    ) {
      onSelectionTooSmall();
      return;
    }
    onSelectionCommit(nextSelection);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearDraft();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onAnalyzeFullImage();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-[inherit]">
      {!selectionMode && result?.highlightedPixels ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          width={result.width}
          height={result.height}
          className="pointer-events-none absolute z-20"
          style={selectionStyle(selection ?? FULL_IMAGE_RECT)}
        />
      ) : null}
      {selectionMode ? (
        <div
          className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair touch-none bg-black/10 outline-none focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-inset"
          role="region"
          tabIndex={0}
          aria-label={t("common.quick_look.sharpness_selection_label")}
          aria-keyshortcuts="Enter Space Escape"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onKeyDown={handleKeyDown}
        />
      ) : null}
      {selection ? (
        <span
          ref={committedBoxRef}
          aria-hidden="true"
          className="pointer-events-none absolute z-30 block border-2 border-rose-400 shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
          style={selectionStyle(selection)}
        />
      ) : null}
      <span
        ref={draftBoxRef}
        aria-hidden="true"
        className="pointer-events-none absolute z-30 border-2 border-dashed border-rose-400 shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
        style={{ display: "none" }}
      />
    </div>
  );
});
