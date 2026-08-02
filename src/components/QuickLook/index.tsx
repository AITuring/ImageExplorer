import {
  memo,
  useEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { X, ExternalLink, File, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FocusRegionOverlay } from "@/components/FocusRegionOverlay";
import { iconCache, loadFileThumbnail } from "@/lib/iconCache";
import type { FileEntry } from "@/types/index";
import { isAnalyzablePhoto, type FocusAnalysis, type PhotoAnalysisRecord } from "@/lib/photoAnalysis";
import {
  getCameraAfRegions,
  loadCameraAfMetadata,
  type CameraAfMetadata,
} from "@/lib/cameraAfMetadata";
import {
  isTextFile,
  isImageFile,
  isBrowserSupportedImage,
  isVideoFile,
  isAudioFile,
  isPdfFile,
} from "@/utils/file";
import { formatFileSize, formatDate } from "@/utils/format";
import { RAW_IMAGE_EXTENSIONS } from "@/constants/fileTypes";

interface QuickLookProps {
  entry: FileEntry | null;
  entries: FileEntry[];
  photoAnalysis?: ReadonlyMap<string, PhotoAnalysisRecord>;
  onClose: () => void;
  onNavigate: (entry: FileEntry) => void;
}

type PreviewType = "text" | "image" | "video" | "audio" | "pdf" | "icon";

interface ImageDimensions {
  width: number;
  height: number;
}

const MAX_IMAGE_ZOOM = 6;
const MIN_IMAGE_ZOOM = 1;
const THUMBNAIL_SIZE_STEPS = [384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144];
const MIN_SCROLL_ADJUST_DELTA = 6;
const MAX_RAW_PREVIEW_SIZE = 6144;
const RAW_EXTENSIONS = new Set(RAW_IMAGE_EXTENSIONS);

function clampZoom(value: number) {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value));
}

function snapThumbnailSize(value: number) {
  return (
    THUMBNAIL_SIZE_STEPS.find((step) => value <= step) ??
    THUMBNAIL_SIZE_STEPS[THUMBNAIL_SIZE_STEPS.length - 1]
  );
}

function getPreviewZoomFactor(value: number) {
  if (value <= 1.2) return 1;
  if (value <= 1.8) return 1.5;
  if (value <= 2.8) return 2;
  return 3;
}

const FocusAnalysisDetails = memo(function FocusAnalysisDetails({
  analysis,
  cameraAfMetadata,
}: {
  analysis?: PhotoAnalysisRecord;
  cameraAfMetadata?: CameraAfMetadata | null;
}) {
  const { t } = useTranslation();
  const focusAnalysis = analysis?.focusAnalysis;
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const regions = cameraAfRegions ?? focusAnalysis?.regions ?? [];
  const region = regions[0];

  return (
    <div
      className="bg-muted/30 text-muted-foreground flex min-h-7 w-full shrink-0 items-center justify-center gap-x-3 gap-y-1 rounded-md border px-3 py-1 text-[11px] leading-4"
      role="status"
      aria-live="polite"
    >
      <span className="text-foreground font-medium">
        {cameraAfRegions !== null
          ? t("common.quick_look.focus_camera_af")
          : t("common.quick_look.focus_data")}
      </span>
      {cameraAfMetadata?.source === "camera-maker-note" && cameraAfRegions?.length ? (
        <>
          <span>
            {t("common.quick_look.focus_camera_af_regions", {
              count: cameraAfRegions.length,
            })}
          </span>
          {cameraAfRegions.length === 1 && (
            <span>
              {t("common.quick_look.focus_camera_af_center", {
                x: Math.round((region.x + region.width / 2) * 100),
                y: Math.round((region.y + region.height / 2) * 100),
              })}
            </span>
          )}
          <span>
            {t("common.quick_look.focus_camera_af_size", {
              width: Math.round(region.width * 100),
              height: Math.round(region.height * 100),
            })}
          </span>
          <span>
            {cameraAfMetadata.exact
              ? t("common.quick_look.focus_camera_af_exact")
              : t("common.quick_look.focus_camera_af_approx")}
          </span>
          {cameraAfMetadata.areaMode && <span>{cameraAfMetadata.areaMode}</span>}
        </>
      ) : cameraAfMetadata?.source === "camera-maker-note" ? (
        <>
          <span>{t("common.quick_look.focus_camera_af_unavailable")}</span>
          {cameraAfMetadata.areaMode && <span>{cameraAfMetadata.areaMode}</span>}
          {cameraAfMetadata.focusMode && <span>{cameraAfMetadata.focusMode}</span>}
        </>
      ) : focusAnalysis?.kind === "full-frame" ? (
        <>
          <span>{t("common.quick_look.focus_full_frame")}</span>
          <span>
            {t("common.quick_look.focus_confidence", {
              value: Math.round(focusAnalysis.confidence * 100),
            })}
          </span>
          <span>{t("common.quick_look.focus_method")}</span>
          {cameraAfMetadata?.source === "unavailable" && (
            <span>{t("common.quick_look.focus_camera_af_unavailable")}</span>
          )}
        </>
      ) : focusAnalysis && region ? (
        <>
          <span>
            {t("common.quick_look.focus_regions", {
              count: regions.length,
            })}
          </span>
          {regions.length === 1 && (
            <span>
              {t("common.quick_look.focus_region_position", {
                x: Math.round((region.x + region.width / 2) * 100),
                y: Math.round((region.y + region.height / 2) * 100),
              })}
            </span>
          )}
          <span>
            {t("common.quick_look.focus_region_size", {
              width: Math.round(region.width * 100),
              height: Math.round(region.height * 100),
            })}
          </span>
          <span>
            {t("common.quick_look.focus_confidence", {
              value: Math.round(focusAnalysis.confidence * 100),
            })}
          </span>
          <span>{t("common.quick_look.focus_method")}</span>
          {cameraAfMetadata?.source === "unavailable" && (
            <span>{t("common.quick_look.focus_camera_af_unavailable")}</span>
          )}
        </>
      ) : (
        <>
          <span>{t("common.quick_look.focus_unavailable")}</span>
          {cameraAfMetadata?.source === "unavailable" && (
            <span>{t("common.quick_look.focus_camera_af_unavailable")}</span>
          )}
        </>
      )}
    </div>
  );
});

interface ZoomableImagePreviewProps {
  entry: FileEntry;
  viewportSize: { width: number; height: number };
  imageDimensions: ImageDimensions | null;
  nativePreviewSrc: string | null;
  fallbackSrc: string | null;
  fileSrc: string | null;
  useNativeImagePreview: boolean;
  progressivePreviewRequestSize: number;
  onImageLoadDimensions: (image: HTMLImageElement) => void;
  onBrowserImageError: () => void;
  onZoomDisplayChange: (zoom: number) => void;
  onCommittedZoomChange: (zoom: number) => void;
  focusAnalysis?: FocusAnalysis | null;
  cameraAfMetadata?: CameraAfMetadata | null;
}

interface ZoomableImageElementProps {
  entry: FileEntry;
  src: string;
  fittedImageSize: { width: number; height: number } | null;
  imageZoom: number;
  isZooming: boolean;
  onLoad: (image: HTMLImageElement) => void;
  onError?: () => void;
  focusAnalysis?: FocusAnalysis | null;
  cameraAfMetadata?: CameraAfMetadata | null;
}

const ZoomableImageElement = memo(function ZoomableImageElement({
  entry,
  src,
  fittedImageSize,
  imageZoom,
  isZooming,
  onLoad,
  onError,
  focusAnalysis,
  cameraAfMetadata,
}: ZoomableImageElementProps) {
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const focusRegions =
    cameraAfRegions ?? (focusAnalysis?.kind === "full-frame" ? [] : (focusAnalysis?.regions ?? []));
  const frameStyle: CSSProperties = {
    ...(fittedImageSize
      ? {
          width: `${fittedImageSize.width}px`,
          height: `${fittedImageSize.height}px`,
          maxWidth: "none",
          maxHeight: "none",
        }
      : {}),
    transform: `translate3d(0, 0, 0) scale(${imageZoom})`,
    transformOrigin: "center center",
    willChange: "transform",
    backfaceVisibility: "hidden",
  };

  return (
    <div className="relative shrink-0" style={frameStyle}>
      <img
        key={entry.path}
        src={src}
        alt={entry.name}
        className={`${fittedImageSize ? "h-full w-full" : "h-auto max-h-full w-auto max-w-full"} select-none ${isZooming ? "" : "rounded-lg shadow-lg"}`}
        decoding="async"
        draggable={false}
        onLoad={(event) => onLoad(event.currentTarget)}
        onError={onError}
      />
      {focusRegions.map((region) => (
        <FocusRegionOverlay
          key={`${region.x}-${region.y}-${region.width}-${region.height}`}
          variant={cameraAfRegions !== null ? "camera" : "estimate"}
          showCenterPoint={cameraAfRegions !== null && !cameraAfMetadata?.exact}
          position={{
            left: region.x * 100,
            top: region.y * 100,
            width: region.width * 100,
            height: region.height * 100,
          }}
        />
      ))}
    </div>
  );
});

const ZoomableImagePreview = memo(function ZoomableImagePreview({
  entry,
  viewportSize,
  imageDimensions,
  nativePreviewSrc,
  fallbackSrc,
  fileSrc,
  useNativeImagePreview,
  progressivePreviewRequestSize,
  onImageLoadDimensions,
  onBrowserImageError,
  onZoomDisplayChange,
  onCommittedZoomChange,
  focusAnalysis,
  cameraAfMetadata,
}: ZoomableImagePreviewProps) {
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const focusRegions =
    cameraAfRegions ?? (focusAnalysis?.kind === "full-frame" ? [] : (focusAnalysis?.regions ?? []));
  const [previewViewport, setPreviewViewport] = useState({ width: 0, height: 0 });
  const [imageZoom, setImageZoom] = useState(1);
  const [isZooming, setIsZooming] = useState(false);
  const imageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageZoomRef = useRef(1);
  const pendingZoomRef = useRef<number | null>(null);
  const zoomAnimationFrameRef = useRef<number | null>(null);
  const commitZoomTimeoutRef = useRef<number | null>(null);
  const zoomInteractionTimeoutRef = useRef<number | null>(null);
  const scrollAdjustmentRef = useRef<{
    previousZoom: number;
    nextZoom: number;
    previousCenterX: number;
    previousCenterY: number;
    pointerOffsetX: number | null;
    pointerOffsetY: number | null;
    pointerClientX: number | null;
    pointerClientY: number | null;
    rectLeft: number | null;
    rectTop: number | null;
  } | null>(null);

  const imageViewportSize = useMemo(() => {
    if (previewViewport.width > 0 && previewViewport.height > 0) {
      return previewViewport;
    }

    return {
      width: Math.max(320, Math.floor(viewportSize.width * 0.92)),
      height: Math.max(240, Math.floor(viewportSize.height * 0.82)),
    };
  }, [previewViewport, viewportSize.height, viewportSize.width]);

  const fittedImageSize = useMemo(() => {
    if (!imageDimensions) {
      return null;
    }

    const scale = Math.min(
      imageViewportSize.width / imageDimensions.width,
      imageViewportSize.height / imageDimensions.height
    );

    return {
      width: Math.max(1, Math.round(imageDimensions.width * scale)),
      height: Math.max(1, Math.round(imageDimensions.height * scale)),
    };
  }, [imageDimensions, imageViewportSize.height, imageViewportSize.width]);

  const zoomedCanvasSize = useMemo(() => {
    if (!fittedImageSize) {
      return null;
    }

    return {
      width: Math.max(imageViewportSize.width, Math.round(fittedImageSize.width * imageZoom)),
      height: Math.max(imageViewportSize.height, Math.round(fittedImageSize.height * imageZoom)),
    };
  }, [fittedImageSize, imageViewportSize.height, imageViewportSize.width, imageZoom]);

  useEffect(() => {
    imageZoomRef.current = imageZoom;
    onZoomDisplayChange(imageZoom);
  }, [imageZoom, onZoomDisplayChange]);

  useEffect(() => {
    const viewport = imageViewportRef.current;
    if (!viewport) {
      return;
    }

    const updateSize = () => {
      setPreviewViewport({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, [entry.path]);

  useEffect(() => {
    if (commitZoomTimeoutRef.current) {
      window.clearTimeout(commitZoomTimeoutRef.current);
    }

    commitZoomTimeoutRef.current = window.setTimeout(() => {
      onCommittedZoomChange(imageZoomRef.current);
    }, 320);

    return () => {
      if (commitZoomTimeoutRef.current) {
        window.clearTimeout(commitZoomTimeoutRef.current);
        commitZoomTimeoutRef.current = null;
      }
    };
  }, [imageZoom, onCommittedZoomChange]);

  useEffect(() => {
    const adjustment = scrollAdjustmentRef.current;
    if (!adjustment || Math.abs(adjustment.nextZoom - imageZoom) >= 0.01) {
      return;
    }

    const viewport = imageViewportRef.current;
    if (!viewport) {
      scrollAdjustmentRef.current = null;
      return;
    }

    const ratio = adjustment.nextZoom / adjustment.previousZoom;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      scrollAdjustmentRef.current = null;
      return;
    }

    let nextScrollLeft: number;
    let nextScrollTop: number;
    if (
      adjustment.pointerOffsetX !== null &&
      adjustment.pointerOffsetY !== null &&
      adjustment.pointerClientX !== null &&
      adjustment.pointerClientY !== null &&
      adjustment.rectLeft !== null &&
      adjustment.rectTop !== null
    ) {
      nextScrollLeft = Math.max(
        0,
        adjustment.pointerOffsetX * ratio - (adjustment.pointerClientX - adjustment.rectLeft)
      );
      nextScrollTop = Math.max(
        0,
        adjustment.pointerOffsetY * ratio - (adjustment.pointerClientY - adjustment.rectTop)
      );
    } else {
      nextScrollLeft = Math.max(0, adjustment.previousCenterX * ratio - viewport.clientWidth / 2);
      nextScrollTop = Math.max(0, adjustment.previousCenterY * ratio - viewport.clientHeight / 2);
    }

    const scrollDeltaX = Math.abs(nextScrollLeft - viewport.scrollLeft);
    const scrollDeltaY = Math.abs(nextScrollTop - viewport.scrollTop);
    if (scrollDeltaX < MIN_SCROLL_ADJUST_DELTA && scrollDeltaY < MIN_SCROLL_ADJUST_DELTA) {
      scrollAdjustmentRef.current = null;
      return;
    }

    viewport.scrollLeft = nextScrollLeft;
    viewport.scrollTop = nextScrollTop;

    scrollAdjustmentRef.current = null;
  }, [imageZoom]);

  const updateImageZoom = useCallback(
    (nextZoom: number, anchor?: { clientX: number; clientY: number }) => {
      const clampedZoom = clampZoom(nextZoom);
      const currentZoom = pendingZoomRef.current ?? imageZoomRef.current;
      if (Math.abs(clampedZoom - currentZoom) < 0.01) {
        return;
      }

      const viewport = imageViewportRef.current;
      const rect = viewport?.getBoundingClientRect();
      scrollAdjustmentRef.current = viewport
        ? {
            previousZoom: currentZoom,
            nextZoom: clampedZoom,
            previousCenterX: viewport.scrollLeft + viewport.clientWidth / 2,
            previousCenterY: viewport.scrollTop + viewport.clientHeight / 2,
            pointerOffsetX:
              rect && anchor ? anchor.clientX - rect.left + viewport.scrollLeft : null,
            pointerOffsetY: rect && anchor ? anchor.clientY - rect.top + viewport.scrollTop : null,
            pointerClientX: anchor?.clientX ?? null,
            pointerClientY: anchor?.clientY ?? null,
            rectLeft: rect?.left ?? null,
            rectTop: rect?.top ?? null,
          }
        : null;

      pendingZoomRef.current = clampedZoom;
      setIsZooming(true);
      if (zoomInteractionTimeoutRef.current !== null) {
        window.clearTimeout(zoomInteractionTimeoutRef.current);
      }
      zoomInteractionTimeoutRef.current = window.setTimeout(() => {
        setIsZooming(false);
      }, 120);

      if (zoomAnimationFrameRef.current !== null) {
        return;
      }

      zoomAnimationFrameRef.current = window.requestAnimationFrame(() => {
        zoomAnimationFrameRef.current = null;
        const pendingZoom = pendingZoomRef.current;
        if (pendingZoom === null) {
          return;
        }

        pendingZoomRef.current = null;
        setImageZoom(pendingZoom);
      });
    },
    []
  );

  const handleImageWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();
      const sensitivity = event.ctrlKey ? 0.02 : 0.01;
      const zoomFactor = Math.exp(-event.deltaY * sensitivity);
      updateImageZoom((pendingZoomRef.current ?? imageZoomRef.current) * zoomFactor, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    [updateImageZoom]
  );

  useEffect(() => {
    return () => {
      if (zoomAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(zoomAnimationFrameRef.current);
      }
      if (commitZoomTimeoutRef.current !== null) {
        window.clearTimeout(commitZoomTimeoutRef.current);
      }
      if (zoomInteractionTimeoutRef.current !== null) {
        window.clearTimeout(zoomInteractionTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={imageViewportRef}
      className="flex h-full w-full overflow-auto"
      style={{
        contain: "layout paint size",
        isolation: "isolate",
        overscrollBehavior: "contain",
      }}
      onWheel={handleImageWheel}
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center"
        style={
          zoomedCanvasSize
            ? {
                width: `${zoomedCanvasSize.width}px`,
                height: `${zoomedCanvasSize.height}px`,
              }
            : undefined
        }
      >
        {useNativeImagePreview || !isBrowserSupportedImage(entry.extension) ? (
          nativePreviewSrc ? (
            <ZoomableImageElement
              entry={{ ...entry, path: `${entry.path}:${nativePreviewSrc}` }}
              src={nativePreviewSrc}
              fittedImageSize={fittedImageSize}
              imageZoom={imageZoom}
              isZooming={isZooming}
              onLoad={onImageLoadDimensions}
              focusAnalysis={focusAnalysis}
              cameraAfMetadata={cameraAfMetadata}
            />
          ) : (
            <div
              className="relative shrink-0"
              style={
                fittedImageSize
                  ? {
                      width: `${fittedImageSize.width}px`,
                      height: `${fittedImageSize.height}px`,
                      transform: `translate3d(0, 0, 0) scale(${imageZoom})`,
                      transformOrigin: "center center",
                    }
                  : {
                      transform: `translate3d(0, 0, 0) scale(${imageZoom})`,
                      transformOrigin: "center center",
                    }
              }
            >
              <FileThumbnail
                entry={entry}
                size={320}
                requestSizeOverride={progressivePreviewRequestSize}
                className={`${fittedImageSize ? "h-full w-full" : "h-auto max-h-full w-auto max-w-full"} object-contain ${isZooming ? "" : "rounded-lg shadow-lg"}`}
                fallbackClassName="text-muted-foreground h-40 w-40"
                onImageLoad={onImageLoadDimensions}
              />
              {fittedImageSize &&
                focusRegions.map((region) => (
                  <FocusRegionOverlay
                    key={`${region.x}-${region.y}-${region.width}-${region.height}`}
                    variant={cameraAfRegions !== null ? "camera" : "estimate"}
                    showCenterPoint={cameraAfRegions !== null && !cameraAfMetadata?.exact}
                    position={{
                      left: region.x * 100,
                      top: region.y * 100,
                      width: region.width * 100,
                      height: region.height * 100,
                    }}
                  />
                ))}
            </div>
          )
        ) : (
          <ZoomableImageElement
            entry={entry}
            src={fallbackSrc || fileSrc || ""}
            fittedImageSize={fittedImageSize}
            imageZoom={imageZoom}
            isZooming={isZooming}
            onLoad={onImageLoadDimensions}
            onError={onBrowserImageError}
            focusAnalysis={focusAnalysis}
            cameraAfMetadata={cameraAfMetadata}
          />
        )}
      </div>
    </div>
  );
});

export function QuickLook({ entry, entries, photoAnalysis, onClose, onNavigate }: QuickLookProps) {
  const { t } = useTranslation();

  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [useNativeImagePreview, setUseNativeImagePreview] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<ImageDimensions | null>(null);
  const [nativePreviewSrc, setNativePreviewSrc] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  const [committedZoom, setCommittedZoom] = useState(1);
  const [cameraAfMetadata, setCameraAfMetadata] = useState<CameraAfMetadata | null>(null);
  const zoomIndicatorRef = useRef<HTMLSpanElement | null>(null);

  // 缓存 convertFileSrc 结果，避免重复转换
  const fileSrc = useMemo(() => {
    if (!entry) return null;
    return convertFileSrc(entry.path);
  }, [entry]);

  // 根据 entry 计算预览类型
  const previewType: PreviewType = useMemo(() => {
    if (!entry || entry.is_dir) return "icon";
    // 忽略 macOS 的元数据文件 (AppleDouble)
    if (entry.name.startsWith("._")) return "icon";

    if (isImageFile(entry.extension)) return "image";
    if (isVideoFile(entry.extension)) return "video";
    if (isAudioFile(entry.extension)) return "audio";
    if (isPdfFile(entry.extension)) return "pdf";
    if (isTextFile(entry.extension) && entry.size < 1024 * 1024) return "text";
    return "icon";
  }, [entry]);

  const dialogSizeClass = useMemo(() => {
    if (!entry) {
      return "h-[min(88vh,48rem)] w-[min(92vw,72rem)]";
    }

    switch (previewType) {
      case "image":
        return "h-[min(92vh,64rem)] w-[min(96vw,96rem)]";
      case "pdf":
      case "video":
        return "h-[min(92vh,64rem)] w-[min(96vw,96rem)]";
      case "text":
        return "h-[min(88vh,56rem)] w-[min(92vw,80rem)]";
      default:
        return "h-[min(82vh,42rem)] w-[min(88vw,56rem)]";
    }
  }, [entry, previewType]);

  const contentPaddingClass =
    previewType === "image" || previewType === "pdf" || previewType === "video"
      ? "p-1.5 md:p-2"
      : "p-8";

  const quickLookEntries = useMemo(
    () => entries.filter((candidate) => !candidate.name.startsWith("._")),
    [entries]
  );
  const currentEntryIndex = useMemo(() => {
    if (!entry) {
      return -1;
    }
    return quickLookEntries.findIndex((candidate) => candidate.path === entry.path);
  }, [entry, quickLookEntries]);
  const previousEntry = currentEntryIndex > 0 ? quickLookEntries[currentEntryIndex - 1] : null;
  const nextEntry =
    currentEntryIndex >= 0 && currentEntryIndex < quickLookEntries.length - 1
      ? quickLookEntries[currentEntryIndex + 1]
      : null;
  const canNavigate = quickLookEntries.length > 1;
  const previewZoomFactor = useMemo(() => getPreviewZoomFactor(committedZoom), [committedZoom]);
  const isRawImage = Boolean(entry && RAW_EXTENSIONS.has((entry.extension || "").toLowerCase()));

  useEffect(() => {
    if (!entry || previewType !== "image" || !isAnalyzablePhoto(entry)) {
      setCameraAfMetadata(null);
      return;
    }

    let cancelled = false;
    setCameraAfMetadata(null);
    void loadCameraAfMetadata(entry).then((metadata) => {
      if (!cancelled) setCameraAfMetadata(metadata);
    });

    return () => {
      cancelled = true;
    };
  }, [entry, previewType]);

  useEffect(() => {
    if (!entry || previewType !== "image") {
      return;
    }

    const candidates = [previousEntry, nextEntry].filter((candidate): candidate is FileEntry =>
      Boolean(candidate && !candidate.is_dir && isImageFile(candidate.extension))
    );
    if (candidates.length === 0) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      for (const candidate of candidates) {
        const extension = (candidate.extension || "").toLowerCase();
        // Browser-native JPEG/PNG decoding is already cheap. Prioritize RAW and
        // formats that need the native thumbnail bridge so arrow navigation can
        // reuse a nearby preview immediately.
        if (isBrowserSupportedImage(extension) && !RAW_EXTENSIONS.has(extension)) {
          continue;
        }

        const cacheKey = `quicklook-prefetch:${candidate.path}:${candidate.modified ?? 0}:${candidate.size}:768`;
        void loadFileThumbnail(cacheKey, candidate.path, 768, true, controller.signal);
      }
    }, 90);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [entry, nextEntry, previewType, previousEntry]);

  const nativePreviewRequestSize = useMemo(() => {
    if (previewType !== "image" || !entry) {
      return 768;
    }

    const viewportMax = Math.max(viewportSize.width, viewportSize.height);
    const devicePixelRatio =
      typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const zoomScale = previewZoomFactor;
    const baseSize = snapThumbnailSize(
      Math.max(1024, Math.round(viewportMax * 0.86 * devicePixelRatio * zoomScale))
    );
    const extension = (entry.extension || "").toLowerCase();

    if (isRawImage) {
      // RAW 预览直接请求一张足够清晰的图，避免先显示 384px 缩略图后一直
      // 停留在模糊状态；列表缩略图仍然小尺寸，空格预览只解码当前文件。
      // Keep the first full RAW frame above the 1.5x zoom threshold even on a
      // 1x external display; a 1536px render is visibly soft in a large Quick
      // Look window before the next zoom-triggered request arrives.
      return Math.min(MAX_RAW_PREVIEW_SIZE, Math.max(3072, baseSize));
    }

    if (extension === "psd") {
      if (entry.size > 400 * 1024 * 1024) {
        return Math.min(2048, baseSize);
      }
      if (entry.size > 160 * 1024 * 1024) {
        return Math.min(3072, Math.max(1536, baseSize));
      }
      return Math.min(4096, Math.max(2048, baseSize));
    }

    return baseSize;
  }, [entry, isRawImage, previewType, previewZoomFactor, viewportSize.height, viewportSize.width]);

  const progressivePreviewRequestSize = useMemo(() => {
    if (previewType !== "image" || !entry) {
      return 384;
    }

    const extension = (entry.extension || "").toLowerCase();
    if (isRawImage) {
      // A 768px RAW placeholder is visibly soft as soon as the user zooms.
      // Quick Look only has one active image, so start with enough pixels for
      // the fitted viewport while the larger zoom-specific render decodes.
      const devicePixelRatio =
        typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      const viewportMax = Math.max(viewportSize.width, viewportSize.height);
      return Math.min(
        2048,
        snapThumbnailSize(Math.max(1024, Math.round(viewportMax * devicePixelRatio)))
      );
    }

    if (extension === "psd") {
      return entry.size > 120 * 1024 * 1024 ? 512 : 768;
    }

    return 384;
  }, [entry, isRawImage, previewType, viewportSize.height, viewportSize.width]);

  const cachedNativePreview = useMemo(() => {
    if (!entry) {
      return null;
    }

    const prefix = `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:`;
    let bestMatch: { size: number; src: string } | null = null;

    for (const [cacheKey, value] of Object.entries(iconCache)) {
      if (!cacheKey.startsWith(prefix) || value === "failed") {
        continue;
      }

      const size = Number(cacheKey.slice(prefix.length));
      if (!Number.isFinite(size)) {
        continue;
      }

      if (!bestMatch || size > bestMatch.size) {
        bestMatch = {
          size,
          src: `data:image/png;base64,${value}`,
        };
      }
    }

    return bestMatch;
  }, [entry]);

  const dialogStyle = useMemo<CSSProperties | undefined>(() => {
    if (previewType !== "image" || !imageDimensions) {
      return undefined;
    }

    const HEADER_HEIGHT = 44;
    const CONTENT_PADDING_X = 10;
    const CONTENT_PADDING_Y = 10;
    const BORDER = 1;
    const MIN_DIALOG_WIDTH = 240;
    const MIN_DIALOG_HEIGHT = 220;
    const maxDialogWidth = Math.max(320, Math.floor(viewportSize.width * 0.96));
    const maxDialogHeight = Math.max(260, Math.floor(viewportSize.height * 0.92));
    const maxContentWidth = Math.max(120, maxDialogWidth - CONTENT_PADDING_X - BORDER);
    const maxContentHeight = Math.max(
      120,
      maxDialogHeight - HEADER_HEIGHT - CONTENT_PADDING_Y - BORDER
    );

    const scale = Math.min(
      maxContentWidth / imageDimensions.width,
      maxContentHeight / imageDimensions.height
    );

    const contentWidth = Math.round(imageDimensions.width * scale);
    const contentHeight = Math.round(imageDimensions.height * scale);

    return {
      width: `${Math.min(maxDialogWidth, Math.max(MIN_DIALOG_WIDTH, contentWidth + CONTENT_PADDING_X + BORDER))}px`,
      height: `${Math.min(
        maxDialogHeight,
        Math.max(MIN_DIALOG_HEIGHT, contentHeight + HEADER_HEIGHT + CONTENT_PADDING_Y + BORDER)
      )}px`,
    };
  }, [imageDimensions, previewType, viewportSize.height, viewportSize.width]);

  // 当 entry 变化时，重置错误状态
  useEffect(() => {
    setError(null);
    setTextContent(null);
    setFallbackSrc(null);
    setUseNativeImagePreview(false);
    setImageDimensions(null);
    setNativePreviewSrc(null);
    setCommittedZoom(1);
    setCameraAfMetadata(null);
  }, [entry]);

  const updateZoomIndicator = useCallback((zoom: number | null) => {
    if (!zoomIndicatorRef.current) {
      return;
    }
    zoomIndicatorRef.current.textContent = zoom === null ? "" : ` ${Math.round(zoom * 100)}%`;
  }, []);

  useEffect(() => {
    updateZoomIndicator(previewType === "image" ? 1 : null);
  }, [entry, previewType, updateZoomIndicator]);

  useEffect(() => {
    const handleResize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ESC 关闭 + 媒体清理
  useEffect(() => {
    if (!entry) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (!canNavigate) {
        return;
      }

      if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && previousEntry) {
        e.preventDefault();
        onNavigate(previousEntry);
        return;
      }

      if ((e.key === "ArrowRight" || e.key === "ArrowDown") && nextEntry) {
        e.preventDefault();
        onNavigate(nextEntry);
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // 暂停所有媒体元素
      document.querySelectorAll("video, audio").forEach((el) => {
        (el as HTMLMediaElement).pause();
      });
    };
  }, [canNavigate, entry, nextEntry, onClose, onNavigate, previousEntry]);

  useEffect(() => {
    // sips 不支持部分 RAW 格式，且在 macOS 上可能启动一个失败的子进程；
    // RAW 的尺寸直接从 Quick Look 缩略图 onLoad 获取。
    if (!entry || previewType !== "image" || isRawImage) {
      return;
    }

    let cancelled = false;

    invoke<ImageDimensions>("read_image_dimensions", { path: entry.path })
      .then((dimensions) => {
        if (!cancelled && dimensions.width > 0 && dimensions.height > 0) {
          setImageDimensions(dimensions);
        }
      })
      .catch(() => {
        // Keep browser onLoad as a fallback for supported images.
      });

    return () => {
      cancelled = true;
    };
  }, [entry, isRawImage, previewType]);

  useEffect(() => {
    if (
      !entry ||
      previewType !== "image" ||
      (isBrowserSupportedImage(entry.extension) && !useNativeImagePreview)
    ) {
      return;
    }

    let cancelled = false;
    const progressiveCacheKey = `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:${progressivePreviewRequestSize}`;
    const fullCacheKey = `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:${nativePreviewRequestSize}`;

    if (cachedNativePreview?.src) {
      setNativePreviewSrc(cachedNativePreview.src);
    }

    const applyPreview = (base64: string | null) => {
      if (!cancelled && base64) {
        setNativePreviewSrc(`data:image/png;base64,${base64}`);
      }
    };

    const loadFullPreview = () => {
      if (cancelled) {
        return Promise.resolve();
      }

      if (cachedNativePreview && cachedNativePreview.size >= nativePreviewRequestSize) {
        return Promise.resolve();
      }

      return loadFileThumbnail(fullCacheKey, entry.path, nativePreviewRequestSize).then(
        applyPreview
      );
    };

    const shouldLoadProgressive =
      !cachedNativePreview || cachedNativePreview.size < progressivePreviewRequestSize;

    if (isRawImage) {
      // 先显示较小的 RAW 预览，再在后台升级到当前缩放所需的尺寸，避免
      // 空格预览必须等待一次完整的高分辨率解码。
      if (shouldLoadProgressive) {
        loadFileThumbnail(progressiveCacheKey, entry.path, progressivePreviewRequestSize)
          .then(applyPreview)
          .finally(() => {
            if (!cancelled) void loadFullPreview();
          });
      } else {
        void loadFullPreview();
      }
      return () => {
        cancelled = true;
      };
    }

    if (shouldLoadProgressive) {
      loadFileThumbnail(progressiveCacheKey, entry.path, progressivePreviewRequestSize)
        .then(applyPreview)
        .finally(() => {
          if (!cancelled) void loadFullPreview();
        });
      return () => {
        cancelled = true;
      };
    }

    void loadFullPreview();

    return () => {
      cancelled = true;
    };
  }, [
    cachedNativePreview,
    entry,
    nativePreviewRequestSize,
    isRawImage,
    previewZoomFactor,
    previewType,
    progressivePreviewRequestSize,
    useNativeImagePreview,
  ]);

  useEffect(() => {
    // 只有文本文件才需要加载内容
    if (!entry || previewType !== "text") {
      return;
    }

    let cancelled = false;

    const loadText = async () => {
      try {
        setLoading(true);
        setError(null);
        const content = await invoke<string>("read_text_file", {
          path: entry.path,
          maxSize: 1024 * 1024,
        });
        if (!cancelled) {
          setTextContent(content);
        }
      } catch (err) {
        console.error("Failed to read text:", err);
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadText();

    return () => {
      cancelled = true;
    };
  }, [entry, previewType]);

  const handleOpen = async () => {
    if (!entry) {
      return;
    }

    try {
      await invoke("open_file", { path: entry.path });
      onClose();
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  };

  const handleImageLoadDimensions = useCallback((image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setImageDimensions({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    }
  }, []);

  const handleBrowserImageError = useCallback(() => {
    if (!entry) {
      return;
    }

    if (fallbackSrc) {
      setUseNativeImagePreview(true);
      setError(null);
      return;
    }

    invoke<string>("read_image_base64", { path: entry.path })
      .then((base64) => {
        setFallbackSrc(base64);
        setError(null);
      })
      .catch(() => {
        setUseNativeImagePreview(true);
        setError(null);
      });
  }, [entry, fallbackSrc]);

  if (!entry) return null;

  const renderPreview = () => {
    if (loading) {
      return (
        <div className="text-muted-foreground flex flex-col items-center justify-center">
          <Loader2 className="mb-2 h-8 w-8 animate-spin" />
          <span className="text-xs">{t("common.loading")}</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center p-4 text-center text-red-500">
          <p className="mb-1 text-sm font-medium">{t("common.quick_look.error") || "Error"}</p>
          <p className="text-xs opacity-80">{error}</p>
        </div>
      );
    }

    switch (previewType) {
      case "image":
        return (
          <div className="flex h-full min-h-0 w-full flex-col gap-1">
            <div className="min-h-0 w-full flex-1">
              <ZoomableImagePreview
                key={entry.path}
                entry={entry}
                viewportSize={viewportSize}
                imageDimensions={imageDimensions}
                nativePreviewSrc={nativePreviewSrc}
                fallbackSrc={fallbackSrc}
                fileSrc={fileSrc}
                useNativeImagePreview={useNativeImagePreview}
                progressivePreviewRequestSize={progressivePreviewRequestSize}
                onImageLoadDimensions={handleImageLoadDimensions}
                onBrowserImageError={handleBrowserImageError}
                onZoomDisplayChange={updateZoomIndicator}
                onCommittedZoomChange={setCommittedZoom}
                focusAnalysis={photoAnalysis?.get(entry.path)?.focusAnalysis ?? null}
                cameraAfMetadata={cameraAfMetadata}
              />
            </div>
            <FocusAnalysisDetails
              analysis={photoAnalysis?.get(entry.path)}
              cameraAfMetadata={cameraAfMetadata}
            />
          </div>
        );

      case "video":
        return (
          <div className="flex h-full w-full items-center justify-center">
            <video
              key={entry.path}
              src={fileSrc || ""}
              controls
              className="h-full w-full rounded-lg object-contain shadow-lg"
              onError={(e) => {
                console.error("Video load error:", e);
                setError(t("common.quick_look.error") || "Failed to load video");
              }}
            >
              Your browser does not support video playback.
            </video>
          </div>
        );

      case "audio":
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-8 p-8">
            <div className="relative flex h-32 w-32 items-center justify-center drop-shadow-2xl">
              <SmartIcon
                icon={File}
                className="text-muted-foreground h-32 w-32"
                sysIcon={{ type: "ext", value: entry.extension || "" }}
              />
            </div>
            <audio
              key={entry.path}
              src={fileSrc || ""}
              controls
              className="w-full max-w-md"
              onError={(e) => {
                console.error("Audio load error:", e);
                setError(t("common.quick_look.error") || "Failed to load audio");
              }}
            >
              Your browser does not support audio playback.
            </audio>
          </div>
        );

      case "pdf":
        return (
          <div className="h-full w-full">
            <embed
              key={entry.path}
              src={fileSrc || ""}
              type="application/pdf"
              className="h-full w-full rounded-lg shadow-lg"
              onError={(e) => {
                console.error("PDF load error:", e);
                setError(t("common.quick_look.error") || "Failed to load PDF");
              }}
            />
          </div>
        );

      case "text":
        return textContent !== null ? (
          <div className="bg-muted/30 h-full w-full overflow-auto rounded-md border p-4 shadow-inner">
            <pre className="font-mono text-xs break-words whitespace-pre-wrap">{textContent}</pre>
          </div>
        ) : null;

      case "icon":
      default:
        return (
          <>
            <div className="relative mb-6 flex h-32 w-32 items-center justify-center drop-shadow-2xl">
              <FileThumbnail
                entry={entry}
                size={128}
                className="h-32 w-32 rounded-xl object-contain"
                fallbackClassName={
                  entry.is_dir ? "h-32 w-32 text-blue-500" : "text-muted-foreground h-32 w-32"
                }
              />
            </div>

            <div className="text-center">
              <h2 className="line-clamp-2 px-8 text-2xl font-semibold tracking-tight break-all">
                {entry.name}
              </h2>
              <div className="text-muted-foreground mt-2 space-y-1 text-sm">
                <p>
                  {entry.is_dir
                    ? t("common.folder")
                    : entry.extension?.toUpperCase() || t("common.file")}
                  {" • "}
                  {entry.is_dir ? "--" : formatFileSize(entry.size)}
                </p>
                <p>
                  {t("common.quick_look.modified")}:{" "}
                  {formatDate(entry.modified, "yyyy/MM/dd HH:mm:ss")}
                </p>
              </div>
            </div>
          </>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`bg-background/80 text-foreground animate-in fade-in zoom-in-95 relative flex ${dialogSizeClass} flex-col overflow-hidden rounded-lg border border-black/8 shadow-xl backdrop-blur-md transition-all duration-200`}
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title Bar */}
        <div className="bg-muted/25 flex items-center justify-between border-b border-black/6 px-3 py-2">
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground rounded-full p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
            {canNavigate ? (
              <>
                <button
                  onClick={() => previousEntry && onNavigate(previousEntry)}
                  disabled={!previousEntry}
                  className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 rounded-full p-1 transition-colors hover:bg-black/10 disabled:hover:bg-transparent dark:hover:bg-white/10"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  onClick={() => nextEntry && onNavigate(nextEntry)}
                  disabled={!nextEntry}
                  className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 rounded-full p-1 transition-colors hover:bg-black/10 disabled:hover:bg-transparent dark:hover:bg-white/10"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            ) : null}
          </div>
          <div className="text-sm font-medium opacity-80">
            {t("common.quick_look.preview")}
            <span ref={zoomIndicatorRef}>{previewType === "image" ? " 100%" : ""}</span>
          </div>
          <button
            onClick={handleOpen}
            className="text-primary hover:text-primary/80 flex items-center gap-1 text-sm font-medium transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            {t("common.quick_look.open")}
          </button>
        </div>

        {/* Content */}
        <div
          className={`flex w-full flex-1 flex-col items-center justify-center overflow-hidden ${contentPaddingClass}`}
        >
          {renderPreview()}
        </div>
      </div>
    </div>
  );
}
