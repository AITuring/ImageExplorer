import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronLeft, ChevronRight, Columns2, Star, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileActions, FileEntry } from "@/types";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FinderTagDots } from "@/components/FinderTagDots";
import { PhotoHistogram } from "@/components/PhotoHistogram";
import { AppContextMenu } from "@/components/AppContextMenu";
import { PhotoInspector } from "./PhotoInspector";
import { SharpnessBadge } from "./PhotoDetails";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import { preloadNeighborEntries } from "@/lib/imagePreload";
import { FINDER_TAG_PRESETS, hasFinderTag } from "@/lib/finderTags";
import { extractHistogramFromImageElement, type PhotoHistogramData } from "@/lib/histogramAnalysis";
import { DEFAULT_CULLING_STATE, type PhotoCullingState, type PhotoFlag } from "@/lib/photoCulling";
import { makeNativeFileDragGestureHandlers } from "@/lib/nativeFileDragGesture";
import type { VisibleSharpness } from "@/hooks/useVisibleSharpness";

const FILMSTRIP_ITEM_WIDTH = 86;

interface FileGalleryViewProps {
  entries: FileEntry[];
  selectedPath: string | null;
  selectedPaths: string[];
  selectedFileEntries: FileEntry[];
  fileActions: FileActions;
  visibleSharpness: Map<string, VisibleSharpness>;
  cullingMap?: ReadonlyMap<string, PhotoCullingState>;
  onSelect: (entry: FileEntry, index: number, event: React.MouseEvent) => void;
  onSelectSingle: (path: string, index: number) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onToggleTag?: (entries: FileEntry[], tag: string) => void;
  onSetRating?: (entry: FileEntry, rating: number) => void;
  onSetFlag?: (entry: FileEntry, flag: PhotoFlag) => void;
  onCompare?: (entries: FileEntry[]) => void;
}

const GalleryPreviewStage = memo(function GalleryPreviewStage({
  entry,
  positionLabel,
  verdict,
  culling,
  canGoPrev,
  canGoNext,
  canCompare,
  onPrev,
  onNext,
  onCompare,
  onToggleTag,
  onSetRating,
  onSetFlag,
  onDoubleClick,
}: {
  entry: FileEntry;
  positionLabel: string;
  verdict?: VisibleSharpness;
  culling: PhotoCullingState;
  canGoPrev: boolean;
  canGoNext: boolean;
  canCompare: boolean;
  onPrev: () => void;
  onNext: () => void;
  onCompare?: () => void;
  onToggleTag?: (tag: string) => void;
  onSetRating?: (rating: number) => void;
  onSetFlag?: (flag: PhotoFlag) => void;
  onDoubleClick: (entry: FileEntry) => void;
}) {
  const { t } = useTranslation();
  const metadata = usePhotoMetadata(entry, true);
  const isPhoto = isAnalyzablePhoto(entry);
  const [showClippingOverlay, setShowClippingOverlay] = useState(false);
  const [histogramState, setHistogramState] = useState<{
    path: string;
    histogram: PhotoHistogramData;
    clippingMaskUrl: string | null;
  } | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);

  const handlePreviewImageLoad = useCallback(
    (img: HTMLImageElement) => {
      loadedImageRef.current = img;
      if (!isPhoto) return;
      const extracted = extractHistogramFromImageElement(img, 256, showClippingOverlay);
      if (extracted) {
        setHistogramState({
          path: entry.path,
          histogram: extracted.histogram,
          clippingMaskUrl: extracted.clippingMaskUrl,
        });
      }
    },
    [entry.path, isPhoto, showClippingOverlay]
  );

  const handleToggleClipping = useCallback(() => {
    setShowClippingOverlay((prev) => {
      const next = !prev;
      const img = loadedImageRef.current;
      if (next && img && isPhoto) {
        const extracted = extractHistogramFromImageElement(img, 256, true);
        if (extracted) {
          setHistogramState({
            path: entry.path,
            histogram: extracted.histogram,
            clippingMaskUrl: extracted.clippingMaskUrl,
          });
        }
      }
      return next;
    });
  }, [entry.path, isPhoto]);

  const activeHistogram = histogramState?.path === entry.path ? histogramState.histogram : null;
  const activeClippingUrl =
    showClippingOverlay && histogramState?.path === entry.path
      ? histogramState.clippingMaskUrl
      : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Main large preview area */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-hidden p-4">
        <div
          className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden"
          onDoubleClick={() => onDoubleClick(entry)}
        >
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
            <FileThumbnail
              key={entry.path}
              entry={entry}
              size={768}
              requestSizeOverride={1600}
              className="max-h-full max-w-full rounded-md object-contain shadow-sm"
              fallbackClassName="h-28 w-28 text-muted-foreground"
              onImageLoad={handlePreviewImageLoad}
            />
            {activeClippingUrl && (
              <img
                src={activeClippingUrl}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full rounded-md object-contain"
              />
            )}
          </div>

          {canGoPrev && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onPrev}
              aria-label={t("common.quick_look.previous")}
              title={t("common.quick_look.previous")}
              className="bg-background/80 hover:bg-background border-border/60 text-foreground absolute top-1/2 left-2 -translate-y-1/2 rounded-full border p-1.5 shadow-sm backdrop-blur-sm transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {canGoNext && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onNext}
              aria-label={t("common.quick_look.next")}
              title={t("common.quick_look.next")}
              className="bg-background/80 hover:bg-background border-border/60 text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-full border p-1.5 shadow-sm backdrop-blur-sm transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-2 flex w-full max-w-full flex-wrap items-center justify-center gap-2">
          <FinderTagDots tags={entry.tags} size="md" />
          <span className="max-w-md truncate text-sm font-medium">{entry.name}</span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {positionLabel}
          </span>
          {isPhoto && <SharpnessBadge verdict={verdict} />}
          {onToggleTag && (
            <div
              className="flex items-center gap-1 pl-1"
              title={t("file_list.cull_tag_hint")}
              role="group"
              aria-label={t("tags.section")}
            >
              {FINDER_TAG_PRESETS.map((preset, idx) => {
                const active = hasFinderTag(entry.tags, preset.id);
                const label = `${idx + 1}: ${t(preset.labelKey)}`;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={active}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onToggleTag(preset.id)}
                    className={`h-3.5 w-3.5 rounded-full transition-transform hover:scale-115 ${
                      active
                        ? "ring-foreground ring-offset-background ring-2 ring-offset-1"
                        : "opacity-75 ring-1 ring-black/15 hover:opacity-100"
                    }`}
                    style={{ backgroundColor: preset.color }}
                  />
                );
              })}
            </div>
          )}
          {isPhoto && onSetFlag && (
            <div className="flex items-center gap-1 pl-1">
              <button
                type="button"
                aria-pressed={culling.flag === "pick"}
                title={`${t("file_list.culling.pick")} (P)`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSetFlag(culling.flag === "pick" ? "none" : "pick")}
                className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                  culling.flag === "pick"
                    ? "bg-emerald-500/20 font-medium text-emerald-700 dark:text-emerald-300"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                <Check className="h-3 w-3" aria-hidden="true" />
                {t("file_list.culling.pick")}
              </button>
              <button
                type="button"
                aria-pressed={culling.flag === "reject"}
                title={`${t("file_list.culling.reject")} (X)`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSetFlag(culling.flag === "reject" ? "none" : "reject")}
                className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                  culling.flag === "reject"
                    ? "bg-destructive/20 text-destructive font-medium"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                <XCircle className="h-3 w-3" aria-hidden="true" />
                {t("file_list.culling.reject")}
              </button>
            </div>
          )}
          {isPhoto && onSetRating && (
            <div
              className="flex items-center gap-0.5 pl-1"
              role="group"
              aria-label={t("file_list.culling.rating_any")}
            >
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSetRating(culling.rating === star ? 0 : star)}
                  aria-label={`${star}★`}
                  className="text-muted-foreground p-0.5 transition-colors hover:text-amber-500"
                >
                  <Star
                    className={`h-3.5 w-3.5 ${
                      star <= culling.rating ? "fill-amber-400 text-amber-400" : ""
                    }`}
                  />
                </button>
              ))}
            </div>
          )}
          {canCompare && onCompare && (
            <button
              type="button"
              onClick={onCompare}
              className="border-border/60 hover:bg-accent inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors"
            >
              <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t("file_list.compare_photos")}</span>
            </button>
          )}
        </div>
      </div>

      {/* Right-side RGB histogram + EXIF inspector */}
      <aside
        className="border-border/50 hidden w-72 shrink-0 space-y-3 overflow-y-auto border-l p-4 lg:block"
        aria-label={t("file_list.preview")}
      >
        {isPhoto && (
          <PhotoHistogram
            histogram={activeHistogram}
            showClippingOverlay={showClippingOverlay}
            onToggleClippingOverlay={handleToggleClipping}
          />
        )}
        <PhotoInspector key={entry.path} entry={entry} metadata={metadata} />
      </aside>
    </div>
  );
});

export function FileGalleryView({
  entries,
  selectedPath,
  selectedPaths,
  selectedFileEntries,
  fileActions,
  visibleSharpness,
  cullingMap,
  onSelect,
  onSelectSingle,
  onDoubleClick,
  onToggleTag,
  onSetRating,
  onSetFlag,
  onCompare,
}: FileGalleryViewProps) {
  const { t } = useTranslation();
  const filmstripRef = useRef<HTMLDivElement>(null);
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const activeIndex = useMemo(() => {
    if (entries.length === 0) return -1;
    if (selectedPath) {
      const idx = entries.findIndex((entry) => entry.path === selectedPath);
      if (idx >= 0) return idx;
    }
    return 0;
  }, [entries, selectedPath]);

  const activeEntry = activeIndex >= 0 ? entries[activeIndex] : null;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    horizontal: true,
    getScrollElement: () => filmstripRef.current,
    estimateSize: () => FILMSTRIP_ITEM_WIDTH,
    overscan: 8,
    useAnimationFrameWithResizeObserver: true,
  });

  useEffect(() => {
    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: "center" });
    }
  }, [activeIndex, virtualizer]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      preloadNeighborEntries(entries, activeIndex, "gallery", controller.signal);
    }, 140);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeIndex, entries]);

  const comparePair = useMemo<[FileEntry, FileEntry] | null>(() => {
    const selectedPhotos = selectedFileEntries.filter(isAnalyzablePhoto);
    if (selectedPhotos.length >= 2) {
      return [selectedPhotos[0], selectedPhotos[1]];
    }
    if (!activeEntry || !isAnalyzablePhoto(activeEntry)) return null;
    for (let i = activeIndex + 1; i < entries.length; i += 1) {
      if (isAnalyzablePhoto(entries[i])) return [activeEntry, entries[i]];
    }
    for (let i = activeIndex - 1; i >= 0; i -= 1) {
      if (isAnalyzablePhoto(entries[i])) return [entries[i], activeEntry];
    }
    return null;
  }, [activeEntry, activeIndex, entries, selectedFileEntries]);

  if (!activeEntry) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t("file_list.empty_folder")}
      </div>
    );
  }

  const rangeStart = virtualizer.range?.startIndex ?? 0;
  const rangeEnd = virtualizer.range?.endIndex ?? -1;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <AppContextMenu
        type={activeEntry.is_dir ? "folder" : "file"}
        entry={activeEntry}
        selectedEntries={selectedFileEntries}
        fileActions={fileActions}
        asChild
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <GalleryPreviewStage
            entry={activeEntry}
            positionLabel={`${activeIndex + 1} / ${entries.length}`}
            verdict={visibleSharpness.get(activeEntry.path)}
            culling={cullingMap?.get(activeEntry.path) ?? DEFAULT_CULLING_STATE}
            canGoPrev={activeIndex > 0}
            canGoNext={activeIndex < entries.length - 1}
            canCompare={Boolean(comparePair && onCompare)}
            onPrev={() => {
              const prevIdx = activeIndex - 1;
              if (prevIdx >= 0) onSelectSingle(entries[prevIdx].path, prevIdx);
            }}
            onNext={() => {
              const nextIdx = activeIndex + 1;
              if (nextIdx < entries.length) onSelectSingle(entries[nextIdx].path, nextIdx);
            }}
            onCompare={comparePair && onCompare ? () => onCompare(comparePair) : undefined}
            onToggleTag={onToggleTag ? (tag) => onToggleTag([activeEntry], tag) : undefined}
            onSetRating={onSetRating ? (rating) => onSetRating(activeEntry, rating) : undefined}
            onSetFlag={onSetFlag ? (flag) => onSetFlag(activeEntry, flag) : undefined}
            onDoubleClick={onDoubleClick}
          />
        </div>
      </AppContextMenu>

      {/* Bottom virtualized horizontal filmstrip */}
      <div
        ref={filmstripRef}
        onWheel={(event) => {
          const el = filmstripRef.current;
          if (!el) return;
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            el.scrollLeft += event.deltaY;
          }
        }}
        className="border-border/50 bg-muted/20 h-28 shrink-0 overflow-x-auto overflow-y-hidden border-t px-3 py-2"
        role="listbox"
        aria-label={t("common.view_gallery")}
      >
        <div
          style={{
            width: `${virtualizer.getTotalSize()}px`,
            height: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const entry = entries[virtualItem.index];
            if (!entry) return null;
            const isSelected = selectedPathSet.has(entry.path) || entry.path === activeEntry.path;
            const isInViewport = virtualItem.index >= rangeStart && virtualItem.index <= rangeEnd;
            const dragPaths =
              selectedPathSet.has(entry.path) && selectedPaths.length > 0
                ? selectedPaths
                : [entry.path];
            const nativeDragHandlers = makeNativeFileDragGestureHandlers(dragPaths, {
              allowButtonTarget: true,
            });
            return (
              <div
                key={entry.path}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: `${virtualItem.size}px`,
                  height: "100%",
                  transform: `translateX(${virtualItem.start}px)`,
                }}
                className="px-1"
              >
                <AppContextMenu
                  type={entry.is_dir ? "folder" : "file"}
                  entry={entry}
                  selectedEntries={selectedFileEntries}
                  fileActions={fileActions}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    {...nativeDragHandlers}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => onSelect(entry, virtualItem.index, event)}
                    onDoubleClick={() => onDoubleClick(entry)}
                    title={entry.name}
                    className={`flex h-full w-full flex-col items-center justify-center gap-1 rounded-md p-1 transition-colors ${
                      isSelected
                        ? "bg-primary/15 ring-primary ring-2"
                        : "hover:bg-accent/70 ring-1 ring-transparent"
                    }`}
                  >
                    <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded">
                      <FileThumbnail
                        entry={entry}
                        size={64}
                        isInViewport={isInViewport}
                        isScrolling={virtualizer.isScrolling}
                        className="h-full w-full rounded object-cover"
                        fallbackClassName="h-10 w-10 text-muted-foreground"
                      />
                    </div>
                    <div className="flex w-full items-center justify-center gap-0.5">
                      <FinderTagDots tags={entry.tags} maxDots={2} />
                      <span className="truncate text-[10px] leading-tight">{entry.name}</span>
                    </div>
                  </button>
                </AppContextMenu>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
