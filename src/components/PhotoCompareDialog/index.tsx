import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArrowLeftRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Crown,
  Minus,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FinderTagDots } from "@/components/FinderTagDots";
import { SharpnessBadge } from "@/components/FileList/components/PhotoDetails";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { getPhotoMetadataSummary } from "@/lib/photoMetadata";
import { FINDER_TAG_PRESETS, hasFinderTag } from "@/lib/finderTags";
import { DEFAULT_CULLING_STATE, type PhotoCullingState, type PhotoFlag } from "@/lib/photoCulling";
import {
  buildFileThumbnailUrl,
  buildRawEmbeddedJpegUrl,
  getLargestLoadedFileThumbnailUrl,
  loadHtmlImage,
} from "@/lib/iconCache";
import { RAW_IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import { isBrowserSupportedImage } from "@/utils/file";
import { getCrispCanvasBlitRect } from "@/lib/quickLookCamera";
import type { VisibleSharpness } from "@/hooks/useVisibleSharpness";

const RAW_EXT_SET = new Set<string>(RAW_IMAGE_EXTENSIONS);
const MIN_FULL_EMBEDDED_RAW_EDGE = 3200;

interface PhotoCompareDialogProps {
  entries: FileEntry[] | null;
  allPhotos?: FileEntry[];
  visibleSharpness: Map<string, VisibleSharpness>;
  cullingMap?: ReadonlyMap<string, PhotoCullingState>;
  onClose: () => void;
  onToggleTag: (entry: FileEntry, tag: string) => void;
  onSetRating?: (entry: FileEntry, rating: number) => void;
  onSetFlag?: (entry: FileEntry, flag: PhotoFlag) => void;
  onDelete: (entry: FileEntry) => Promise<void>;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const QUICK_ONE_TO_ONE_ZOOM = 3;

interface SafariGestureEvent extends UIEvent {
  scale: number;
}

const CrispCompareViewportImage = memo(function CrispCompareViewportImage({
  entry,
  zoom,
  pan,
}: {
  entry: FileEntry;
  zoom: number;
  pan: { x: number; y: number };
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [loadedImageVersion, setLoadedImageVersion] = useState(0);
  const [hasLoadedFullOrCached, setHasLoadedFullOrCached] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setViewportSize((current) =>
        current.width === width && current.height === height ? current : { width, height }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    loadedImageRef.current = null;
    queueMicrotask(() => {
      if (!cancelled) {
        setHasLoadedFullOrCached(false);
        setLoadedImageVersion((v) => v + 1);
      }
    });

    const ext = (entry.extension ?? "").toLowerCase();
    const isRaw = RAW_EXT_SET.has(ext);
    const applyLoaded = (img: HTMLImageElement) => {
      if (cancelled || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
      const prev = loadedImageRef.current;
      if (
        prev &&
        Math.max(prev.naturalWidth, prev.naturalHeight) >
          Math.max(img.naturalWidth, img.naturalHeight)
      ) {
        return;
      }
      loadedImageRef.current = img;
      setHasLoadedFullOrCached(true);
      setLoadedImageVersion((v) => v + 1);
    };

    const cached = getLargestLoadedFileThumbnailUrl(entry.path, entry.modified, entry.size);
    if (cached?.url) {
      void loadHtmlImage(cached.url, controller.signal)
        .then(applyLoaded)
        .catch(() => undefined);
    }

    if (isRaw) {
      const fullEmbeddedUrl = buildRawEmbeddedJpegUrl(entry.path, entry.modified, entry.size, 0);
      void loadHtmlImage(fullEmbeddedUrl, controller.signal)
        .then((img) => {
          applyLoaded(img);
          if (Math.max(img.naturalWidth, img.naturalHeight) < MIN_FULL_EMBEDDED_RAW_EDGE) {
            const demosaicUrl = buildFileThumbnailUrl(
              entry.path,
              entry.modified,
              entry.size,
              4096,
              false,
              false
            );
            return loadHtmlImage(demosaicUrl, controller.signal)
              .then(applyLoaded)
              .catch(() => undefined);
          }
        })
        .catch(() => {
          const fallbackUrl = buildFileThumbnailUrl(
            entry.path,
            entry.modified,
            entry.size,
            4096,
            false,
            false
          );
          return loadHtmlImage(fallbackUrl, controller.signal)
            .then(applyLoaded)
            .catch(() => undefined);
        });
    } else if (isBrowserSupportedImage(ext)) {
      const directUrl = convertFileSrc(entry.path);
      void loadHtmlImage(directUrl, controller.signal)
        .then(applyLoaded)
        .catch(() => {
          const fallbackUrl = buildFileThumbnailUrl(
            entry.path,
            entry.modified,
            entry.size,
            4096,
            false,
            false
          );
          return loadHtmlImage(fallbackUrl, controller.signal)
            .then(applyLoaded)
            .catch(() => undefined);
        });
    } else {
      const nativeUrl = buildFileThumbnailUrl(
        entry.path,
        entry.modified,
        entry.size,
        4096,
        false,
        false
      );
      void loadHtmlImage(nativeUrl, controller.signal)
        .then(applyLoaded)
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [entry.extension, entry.modified, entry.path, entry.size]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const img = loadedImageRef.current;
    if (!canvas || viewportSize.width <= 0 || viewportSize.height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const targetW = Math.max(1, Math.round(viewportSize.width * dpr));
    const targetH = Math.max(1, Math.round(viewportSize.height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, targetW, targetH);

    if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

    const pad = 8;
    const availW = Math.max(1, viewportSize.width - pad * 2);
    const availH = Math.max(1, viewportSize.height - pad * 2);
    const fitScale = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
    const fitSize = {
      width: Math.max(1, img.naturalWidth * fitScale),
      height: Math.max(1, img.naturalHeight * fitScale),
    };
    const drawW = fitSize.width * zoom;
    const drawH = fitSize.height * zoom;
    const tx = (viewportSize.width - drawW) / 2 + pan.x;
    const ty = (viewportSize.height - drawH) / 2 + pan.y;

    const blit = getCrispCanvasBlitRect(
      { scale: zoom, tx, ty },
      viewportSize,
      fitSize,
      { width: img.naturalWidth, height: img.naturalHeight },
      dpr
    );
    if (!blit) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      img,
      blit.srcX,
      blit.srcY,
      blit.srcW,
      blit.srcH,
      blit.dstX,
      blit.dstY,
      blit.dstW,
      blit.dstH
    );
  }, [loadedImageVersion, pan.x, pan.y, viewportSize, zoom]);

  return (
    <div ref={containerRef} className="relative flex h-full w-full items-center justify-center">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
      />
      {!hasLoadedFullOrCached && (
        <div className="pointer-events-none flex h-full w-full items-center justify-center p-2">
          <FileThumbnail
            key={entry.path}
            entry={entry}
            size={1024}
            requestSizeOverride={1024}
            className="pointer-events-none max-h-full max-w-full object-contain"
            fallbackClassName="h-24 w-24 text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
});

const ComparePane = memo(function ComparePane({
  entry,
  verdict,
  culling,
  roleLabel,
  isChampion,
  canCycleChallenger,
  onPrevChallenger,
  onNextChallenger,
  onPromoteToChampion,
  zoom,
  pan,
  onRegisterViewport,
  onPanStart,
  onDoubleClick,
  onToggleTag,
  onSetRating,
  onSetFlag,
  onDelete,
}: {
  entry: FileEntry;
  verdict?: VisibleSharpness;
  culling: PhotoCullingState;
  roleLabel?: string;
  isChampion?: boolean;
  canCycleChallenger?: boolean;
  onPrevChallenger?: () => void;
  onNextChallenger?: () => void;
  onPromoteToChampion?: () => void;
  zoom: number;
  pan: { x: number; y: number };
  onRegisterViewport: (el: HTMLDivElement | null) => void;
  onPanStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onToggleTag: (entry: FileEntry, tag: string) => void;
  onSetRating?: (entry: FileEntry, rating: number) => void;
  onSetFlag?: (entry: FileEntry, flag: PhotoFlag) => void;
  onDelete: (entry: FileEntry) => Promise<void>;
}) {
  const { t } = useTranslation();
  const metadata = usePhotoMetadata(entry, true);
  const summary = getPhotoMetadataSummary(metadata);

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-black/90 ${
        culling.flag === "reject" ? "opacity-65" : ""
      }`}
    >
      <div
        ref={onRegisterViewport}
        onMouseDown={onPanStart}
        onDoubleClick={onDoubleClick}
        style={{ touchAction: "none", overscrollBehavior: "none" }}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden select-none ${
          zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
        }`}
      >
        {roleLabel && (
          <div className="bg-background/85 border-border/60 absolute top-2 left-2 z-10 flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur-sm">
            {isChampion && <Crown className="h-3 w-3 text-amber-500" aria-hidden="true" />}
            <span>{roleLabel}</span>
          </div>
        )}
        {canCycleChallenger && (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
            {onPromoteToChampion && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPromoteToChampion();
                }}
                title={t("file_list.culling.compare_promote")}
                className="bg-background/85 hover:bg-background border-border/60 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm transition-colors"
              >
                <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                {t("file_list.culling.compare_promote")}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPrevChallenger?.();
              }}
              aria-label={t("common.quick_look.previous")}
              className="bg-background/85 hover:bg-background border-border/60 rounded-full border p-1 backdrop-blur-sm transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNextChallenger?.();
              }}
              aria-label={t("common.quick_look.next")}
              className="bg-background/85 hover:bg-background border-border/60 rounded-full border p-1 backdrop-blur-sm transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <CrispCompareViewportImage entry={entry} zoom={zoom} pan={pan} />
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
          <div className="flex items-center gap-1">
            {onSetFlag && (
              <>
                <button
                  type="button"
                  aria-pressed={culling.flag === "pick"}
                  title={t("file_list.culling.pick")}
                  onClick={() => onSetFlag(entry, culling.flag === "pick" ? "none" : "pick")}
                  className={`rounded p-1 transition-colors ${
                    culling.flag === "pick"
                      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-pressed={culling.flag === "reject"}
                  title={t("file_list.culling.reject")}
                  onClick={() => onSetFlag(entry, culling.flag === "reject" ? "none" : "reject")}
                  className={`rounded p-1 transition-colors ${
                    culling.flag === "reject"
                      ? "bg-destructive/20 text-destructive"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </button>
              </>
            )}
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
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-muted-foreground truncate text-[11px] tabular-nums">
            {[summary?.dimensions, ...(summary?.exposure ?? [])].filter(Boolean).join(" · ") || "—"}
          </div>
          <div className="flex items-center gap-2">
            {onSetRating && (
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    aria-label={`${star}★`}
                    onClick={() => onSetRating(entry, culling.rating === star ? 0 : star)}
                    className="text-muted-foreground hover:text-amber-500"
                  >
                    <Star
                      className={`h-3 w-3 ${
                        star <= culling.rating ? "fill-amber-400 text-amber-400" : ""
                      }`}
                    />
                  </button>
                ))}
              </div>
            )}
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
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded-full transition-transform hover:scale-110 ${
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
    </div>
  );
});

export function PhotoCompareDialog({
  entries,
  allPhotos = [],
  visibleSharpness,
  cullingMap,
  onClose,
  onToggleTag,
  onSetRating,
  onSetFlag,
  onDelete,
}: PhotoCompareDialogProps) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(() => new Set());
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const panRafRef = useRef<number | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);
  const viewportNodesRef = useRef<Set<HTMLDivElement>>(new Set());
  const nativeGestureActiveRef = useRef(false);
  const nativeGestureBaseZoomRef = useRef(1);
  // PK Challenger override state keyed by the initial session entry paths
  const sessionKey = entries ? entries.map((e) => e.path).join("\0") : "";
  const [pkState, setPkState] = useState<{
    sessionKey: string;
    champion: FileEntry;
    challenger: FileEntry;
  } | null>(null);
  const draggingRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    return () => {
      if (panRafRef.current !== null) {
        window.cancelAnimationFrame(panRafRef.current);
      }
    };
  }, []);

  const schedulePanUpdate = useCallback((nextPan: { x: number; y: number }) => {
    panRef.current = nextPan;
    pendingPanRef.current = nextPan;
    if (panRafRef.current !== null) return;
    panRafRef.current = window.requestAnimationFrame(() => {
      panRafRef.current = null;
      if (pendingPanRef.current) {
        setPan(pendingPanRef.current);
      }
    });
  }, []);

  const availablePhotos = useMemo(
    () => allPhotos.filter((photo) => !deletedPaths.has(photo.path)),
    [allPhotos, deletedPaths]
  );

  const isPkMode = Boolean(entries && entries.length === 2);
  const activeEntries = useMemo(() => {
    if (!entries || entries.length < 2) return null;
    if (isPkMode && pkState && pkState.sessionKey === sessionKey) {
      return [pkState.champion, pkState.challenger];
    }
    return entries.slice(0, 4);
  }, [entries, isPkMode, pkState, sessionKey]);

  const cycleChallenger = useCallback(
    (delta: 1 | -1, excludePaths?: ReadonlySet<string>) => {
      if (!isPkMode || !activeEntries || availablePhotos.length < 2) return false;
      const [champion, currentChallenger] = activeEntries;
      const candidates = availablePhotos.filter(
        (photo) => photo.path !== champion.path && !excludePaths?.has(photo.path)
      );
      if (candidates.length === 0) return false;
      const currentIdx = candidates.findIndex((photo) => photo.path === currentChallenger.path);
      const nextIdx =
        currentIdx < 0 ? 0 : (currentIdx + delta + candidates.length) % candidates.length;
      setPkState({
        sessionKey,
        champion,
        challenger: candidates[nextIdx],
      });
      return true;
    },
    [activeEntries, availablePhotos, isPkMode, sessionKey]
  );

  const promoteChallenger = useCallback(() => {
    if (!isPkMode || !activeEntries) return;
    const [champion, challenger] = activeEntries;
    setPkState({
      sessionKey,
      champion: challenger,
      challenger: champion,
    });
  }, [activeEntries, isPkMode, sessionKey]);

  const resetView = useCallback(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const toggleOneToOne = useCallback(() => {
    setZoom((current) => {
      if (current > 1.05) {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        setPan({ x: 0, y: 0 });
        return 1;
      }
      zoomRef.current = QUICK_ONE_TO_ONE_ZOOM;
      return QUICK_ONE_TO_ONE_ZOOM;
    });
  }, []);

  useEffect(() => {
    if (!activeEntries) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "z" || event.key === "Z") {
        event.preventDefault();
        toggleOneToOne();
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
      } else if (isPkMode && event.key === "Enter") {
        event.preventDefault();
        promoteChallenger();
      } else if (isPkMode && event.key === "ArrowRight") {
        event.preventDefault();
        cycleChallenger(1);
      } else if (isPkMode && event.key === "ArrowLeft") {
        event.preventDefault();
        cycleChallenger(-1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeEntries,
    cycleChallenger,
    isPkMode,
    onClose,
    promoteChallenger,
    resetView,
    toggleOneToOne,
  ]);

  const viewportCleanupMapRef = useRef<Map<HTMLDivElement, () => void>>(new Map());
  const registerViewport = useCallback(
    (node: HTMLDivElement | null) => {
      // Clean up any detached viewport nodes.
      for (const [el, cleanup] of viewportCleanupMapRef.current) {
        if (!el.isConnected) {
          cleanup();
          viewportCleanupMapRef.current.delete(el);
          viewportNodesRef.current.delete(el);
        }
      }
      if (!node || viewportCleanupMapRef.current.has(node)) return;
      viewportNodesRef.current.add(node);

      const onGestureStart = (event: Event) => {
        event.preventDefault();
        nativeGestureActiveRef.current = true;
        nativeGestureBaseZoomRef.current = zoomRef.current;
      };
      const onGestureChange = (event: Event) => {
        const gesture = event as SafariGestureEvent;
        gesture.preventDefault();
        const next = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, Number((nativeGestureBaseZoomRef.current * gesture.scale).toFixed(3)))
        );
        zoomRef.current = next;
        setZoom(next);
        if (next <= 1.005) {
          schedulePanUpdate({ x: 0, y: 0 });
        }
      };
      const onGestureEnd = (event: Event) => {
        event.preventDefault();
        nativeGestureActiveRef.current = false;
      };
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          if (nativeGestureActiveRef.current) return;
          const clampedDelta = Math.max(-120, Math.min(120, event.deltaY));
          const sensitivity = event.ctrlKey ? 0.012 : 0.0045;
          const next = Math.max(
            MIN_ZOOM,
            Math.min(
              MAX_ZOOM,
              Number((zoomRef.current * Math.exp(-clampedDelta * sensitivity)).toFixed(3))
            )
          );
          zoomRef.current = next;
          setZoom(next);
          if (next <= 1.005) {
            schedulePanUpdate({ x: 0, y: 0 });
          }
          return;
        }
        if (zoomRef.current > 1.005) {
          schedulePanUpdate({
            x: panRef.current.x - event.deltaX,
            y: panRef.current.y - event.deltaY,
          });
          return;
        }
        // Standard mouse wheel zoom when at 1x fit.
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, Number((zoomRef.current * factor).toFixed(2)))
        );
        zoomRef.current = next;
        setZoom(next);
      };

      node.addEventListener("gesturestart", onGestureStart, { passive: false });
      node.addEventListener("gesturechange", onGestureChange, { passive: false });
      node.addEventListener("gestureend", onGestureEnd, { passive: false });
      node.addEventListener("wheel", onWheel, { passive: false });

      viewportCleanupMapRef.current.set(node, () => {
        node.removeEventListener("gesturestart", onGestureStart);
        node.removeEventListener("gesturechange", onGestureChange);
        node.removeEventListener("gestureend", onGestureEnd);
        node.removeEventListener("wheel", onWheel);
      });
    },
    [schedulePanUpdate]
  );

  useEffect(() => {
    const cleanups = viewportCleanupMapRef.current;
    const nodes = viewportNodesRef.current;
    return () => {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
      nodes.clear();
    };
  }, []);

  const handlePanStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || zoomRef.current <= 1) return;
      event.preventDefault();
      draggingRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: panRef.current.x,
        originY: panRef.current.y,
      };
      const handleMove = (moveEvent: MouseEvent) => {
        const drag = draggingRef.current;
        if (!drag) return;
        schedulePanUpdate({
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
    [schedulePanUpdate]
  );

  if (!activeEntries) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("file_list.compare_title")}
      onMouseDown={(event) => {
        if ((event.target as Element | null)?.closest("button")) {
          event.preventDefault();
        }
      }}
      className="bg-background/95 fixed inset-0 z-50 flex flex-col p-4 backdrop-blur-md"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {activeEntries.length > 2
              ? t("file_list.culling.compare_survey_title", { count: activeEntries.length })
              : t("file_list.compare_title")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {isPkMode ? t("file_list.culling.compare_pk_hint") : t("file_list.compare_hint")}
          </p>
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
            onClick={toggleOneToOne}
            className="hover:bg-accent border-border/60 rounded border px-2 py-1 text-xs"
          >
            1:1 (Z)
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

      <div
        className={`grid min-h-0 flex-1 gap-3 ${
          activeEntries.length > 2 ? "grid-cols-2 grid-rows-2" : "grid-cols-2"
        }`}
      >
        {activeEntries.map((item, idx) => (
          <ComparePane
            key={`${idx}:${item.path}`}
            entry={item}
            verdict={visibleSharpness.get(item.path)}
            culling={cullingMap?.get(item.path) ?? DEFAULT_CULLING_STATE}
            roleLabel={
              isPkMode
                ? idx === 0
                  ? t("file_list.culling.compare_champion")
                  : t("file_list.culling.compare_challenger")
                : `#${idx + 1}`
            }
            isChampion={isPkMode && idx === 0}
            canCycleChallenger={isPkMode && idx === 1 && availablePhotos.length > 2}
            onPrevChallenger={() => cycleChallenger(-1)}
            onNextChallenger={() => cycleChallenger(1)}
            onPromoteToChampion={promoteChallenger}
            zoom={zoom}
            pan={pan}
            onRegisterViewport={registerViewport}
            onPanStart={handlePanStart}
            onDoubleClick={toggleOneToOne}
            onToggleTag={onToggleTag}
            onSetRating={onSetRating}
            onSetFlag={onSetFlag}
            onDelete={async (target) => {
              await onDelete(target);
              const nextDeleted = new Set(deletedPaths);
              nextDeleted.add(target.path);
              setDeletedPaths(nextDeleted);
              if (isPkMode) {
                if (idx === 1) {
                  if (!cycleChallenger(1, nextDeleted)) onClose();
                } else {
                  // Champion deleted: promote current challenger and load next candidate.
                  const remaining = availablePhotos.filter(
                    (photo) => !nextDeleted.has(photo.path) && photo.path !== activeEntries[1]?.path
                  );
                  if (activeEntries[1] && remaining.length > 0) {
                    setPkState({
                      sessionKey,
                      champion: activeEntries[1],
                      challenger: remaining[0],
                    });
                  } else {
                    onClose();
                  }
                }
              } else {
                onClose();
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
