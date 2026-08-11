import {
  useEffect,
  useRef,
  useState,
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
const FULL_IMAGE_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

function selectionStyle(selection: NormalizedRect): CSSProperties {
  return {
    left: `${selection.x * 100}%`,
    top: `${selection.y * 100}%`,
    width: `${selection.width * 100}%`,
    height: `${selection.height * 100}%`,
  };
}

export function SharpnessSelectionOverlay({
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
  const [draftSelection, setDraftSelection] = useState<NormalizedRect | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const draftSelectionRef = useRef<NormalizedRect | null>(null);
  const draftFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, result.width, result.height);
    context.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  }, [enabled, result, selectionMode]);

  useEffect(() => {
    return () => {
      if (draftFrameRef.current !== null) {
        window.cancelAnimationFrame(draftFrameRef.current);
      }
    };
  }, []);

  if (!enabled) return null;

  const pointFromEvent = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / Math.max(bounds.width, 1),
      y: (event.clientY - bounds.top) / Math.max(bounds.height, 1),
    };
  };

  const publishDraft = (nextSelection: NormalizedRect) => {
    draftSelectionRef.current = nextSelection;
    if (draftFrameRef.current !== null) return;
    draftFrameRef.current = window.requestAnimationFrame(() => {
      draftFrameRef.current = null;
      setDraftSelection(draftSelectionRef.current);
    });
  };

  const clearDraft = () => {
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    selectionStartRef.current = null;
    draftSelectionRef.current = null;
    setDraftSelection(null);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = pointFromEvent(event);
    selectionStartRef.current = start;
    draftSelectionRef.current = normalizedRectFromPoints(start, start);
    setDraftSelection(draftSelectionRef.current);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    if (!start || !event.isPrimary) return;
    event.preventDefault();
    publishDraft(normalizedRectFromPoints(start, pointFromEvent(event)));
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    if (!start || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextSelection = normalizedRectFromPoints(start, pointFromEvent(event));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearDraft();

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

  const visibleSelection = draftSelection ?? selection;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-[inherit]">
      {!selectionMode && result?.highlightedPixels ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          width={result.width}
          height={result.height}
          className="pointer-events-none absolute z-20 drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]"
          style={selectionStyle(selection ?? FULL_IMAGE_RECT)}
        />
      ) : null}
      {selectionMode ? (
        <div
          className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-inset"
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
      {visibleSelection ? (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute z-30 block border-2 border-rose-400 shadow-[0_0_0_1px_rgba(0,0,0,0.85),0_0_0_9999px_rgba(0,0,0,0.12)] ${draftSelection ? "border-dashed" : ""}`}
          style={selectionStyle(visibleSelection)}
        />
      ) : null}
    </div>
  );
}
