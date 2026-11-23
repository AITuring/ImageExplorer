import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FinderTagDots } from "@/components/FinderTagDots";
import { SharpnessBadge } from "@/components/FileList/components/PhotoDetails";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { getPhotoMetadataSummary } from "@/lib/photoMetadata";
import { FINDER_TAG_PRESETS, hasFinderTag } from "@/lib/finderTags";
import type { VisibleSharpness } from "@/hooks/useVisibleSharpness";

interface PhotoCompareDialogProps {
  entries: [FileEntry, FileEntry] | null;
  visibleSharpness: Map<string, VisibleSharpness>;
  onClose: () => void;
  onToggleTag: (entry: FileEntry, tag: string) => void;
  onDelete: (entry: FileEntry) => Promise<void>;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

const ComparePane = memo(function ComparePane({
  entry,
  verdict,
  zoom,
  pan,
  onWheelZoom,
  onPanStart,
  onToggleTag,
  onDelete,
}: {
  entry: FileEntry;
  verdict?: VisibleSharpness;
  zoom: number;
  pan: { x: number; y: number };
  onWheelZoom: (event: React.WheelEvent<HTMLDivElement>) => void;
  onPanStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onToggleTag: (entry: FileEntry, tag: string) => void;
  onDelete: (entry: FileEntry) => Promise<void>;
}) {
  const { t } = useTranslation();
  const metadata = usePhotoMetadata(entry, true);
  const summary = getPhotoMetadataSummary(metadata);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-black/90">
      <div
        onWheel={onWheelZoom}
        onMouseDown={onPanStart}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden select-none ${
          zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
        }`}
      >
        <div
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            transformOrigin: "center center",
            willChange: "transform",
          }}
          className="flex h-full w-full items-center justify-center p-2"
        >
          <FileThumbnail
            key={entry.path}
            entry={entry}
            size={1024}
            requestSizeOverride={2048}
            className="pointer-events-none max-h-full max-w-full object-contain"
            fallbackClassName="h-24 w-24 text-muted-foreground"
          />
        </div>
      </div>

      {/* Footer metadata & quick culling actions */}
      <div className="bg-background/95 border-border/60 flex flex-col gap-1.5 border-t px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <FinderTagDots tags={entry.tags} size="md" />
            <span className="truncate font-medium" title={entry.name}>
              {entry.name}
            </span>
            <SharpnessBadge verdict={verdict} />
          </div>
          {!entry.readonly && (
            <button
              type="button"
              onClick={() => void onDelete(entry)}
              title={t("context_menu.move_to_trash")}
              aria-label={t("context_menu.move_to_trash")}
              className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive shrink-0 rounded p-1 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-muted-foreground truncate text-[11px] tabular-nums">
            {[summary?.dimensions, ...(summary?.exposure ?? [])].filter(Boolean).join(" · ") || "—"}
          </div>
          <div className="flex items-center gap-1">
            {FINDER_TAG_PRESETS.map((preset) => {
              const active = hasFinderTag(entry.tags, preset.id);
              const label = t(preset.labelKey);
              return (
                <button
                  key={preset.id}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => onToggleTag(entry, preset.id)}
                  className={`flex h-4 w-4 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                    active
                      ? "ring-foreground ring-offset-background ring-2 ring-offset-1"
                      : "opacity-75 ring-1 ring-black/15 hover:opacity-100"
                  }`}
                  style={{ backgroundColor: preset.color }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});

export function PhotoCompareDialog({
  entries,
  visibleSharpness,
  onClose,
  onToggleTag,
  onDelete,
}: PhotoCompareDialogProps) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const draggingRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!entries) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => Math.min(MAX_ZOOM, Number((current + 0.5).toFixed(2))));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom((current) => {
          const next = Math.max(MIN_ZOOM, Number((current - 0.5).toFixed(2)));
          if (next <= 1) setPan({ x: 0, y: 0 });
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [entries, onClose, resetView]);

  const handleWheelZoom = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((current) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number((current * factor).toFixed(2))));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handlePanStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || zoom <= 1) return;
      event.preventDefault();
      draggingRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      const handleMove = (moveEvent: MouseEvent) => {
        const drag = draggingRef.current;
        if (!drag) return;
        setPan({
          x: drag.originX + (moveEvent.clientX - drag.startX),
          y: drag.originY + (moveEvent.clientY - drag.startY),
        });
      };
      const handleUp = () => {
        draggingRef.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [pan.x, pan.y, zoom]
  );

  if (!entries) return null;
  const [left, right] = entries;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("file_list.compare_title")}
      className="bg-background/95 fixed inset-0 z-50 flex flex-col p-4 backdrop-blur-md"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("file_list.compare_title")}</h2>
          <p className="text-muted-foreground text-xs">{t("file_list.compare_hint")}</p>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              setZoom((current) => {
                const next = Math.max(MIN_ZOOM, Number((current - 0.5).toFixed(2)));
                if (next <= 1) setPan({ x: 0, y: 0 });
                return next;
              })
            }
            className="hover:bg-accent rounded p-1.5"
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center text-xs font-medium tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() =>
              setZoom((current) => Math.min(MAX_ZOOM, Number((current + 0.5).toFixed(2))))
            }
            className="hover:bg-accent rounded p-1.5"
            aria-label="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(2)}
            className="hover:bg-accent border-border/60 rounded border px-2 py-1 text-xs"
          >
            200%
          </button>
          <button
            type="button"
            onClick={resetView}
            className="hover:bg-accent border-border/60 inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
          >
            <RotateCcw className="h-3 w-3" />
            <span>{t("file_list.compare_reset_zoom")}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.quick_look.close")}
            className="hover:bg-accent ml-2 rounded p-1.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <ComparePane
          entry={left}
          verdict={visibleSharpness.get(left.path)}
          zoom={zoom}
          pan={pan}
          onWheelZoom={handleWheelZoom}
          onPanStart={handlePanStart}
          onToggleTag={onToggleTag}
          onDelete={async (target) => {
            await onDelete(target);
            onClose();
          }}
        />
        <ComparePane
          entry={right}
          verdict={visibleSharpness.get(right.path)}
          zoom={zoom}
          pan={pan}
          onWheelZoom={handleWheelZoom}
          onPanStart={handlePanStart}
          onToggleTag={onToggleTag}
          onDelete={async (target) => {
            await onDelete(target);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
