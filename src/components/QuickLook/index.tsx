import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type ReactNode,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { X, ExternalLink, File, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FocusRegionOverlay } from "@/components/FocusRegionOverlay";
import { SharpnessInspectorToolbar } from "@/components/SharpnessInspectorToolbar";
import { SharpnessSelectionOverlay } from "@/components/SharpnessSelectionOverlay";
import { getLargestCachedFileThumbnail, loadFileThumbnail } from "@/lib/iconCache";
import { useCameraAfMetadata } from "@/hooks/useCameraAfMetadata";
import { useSharpnessInspector } from "@/hooks/useSharpnessInspector";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { getPhotoMetadataSummary } from "@/lib/photoMetadata";
import type { FileEntry } from "@/types/index";
import {
  isAnalyzablePhoto,
  type FocusAnalysis,
  type PhotoAnalysisRecord,
} from "@/lib/photoAnalysis";
import { getCameraAfRegions, type CameraAfMetadata } from "@/lib/cameraAfMetadata";
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
import { isInteractiveKeyboardTarget, shouldIgnoreKeyboardCommand } from "@/lib/keyboardShortcuts";

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
const MIN_SCROLL_ADJUST_DELTA = 0.5;
const MAX_RAW_PREVIEW_SIZE = 6144;
const RAW_EXTENSIONS = new Set(RAW_IMAGE_EXTENSIONS);
const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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
  if (value <= 1.5) return 1;
  if (value <= 2.3) return 1.5;
  if (value <= 3.5) return 2;
  return 3;
}

function shouldUpgradeNativePreview(currentSize: number, requestedSize: number) {
  if (currentSize <= 0) return true;
  if (requestedSize <= currentSize) return false;
  return requestedSize / currentSize >= 1.45;
}

interface ZoomGestureAnchor {
  imageRatioX: number;
  imageRatioY: number;
  originX: number;
  originY: number;
  viewportX: number;
  viewportY: number;
}

function applyLiveZoomTransform(frame: HTMLDivElement, scale: number, anchor: ZoomGestureAnchor) {
  frame.style.transformOrigin = `${anchor.originX}px ${anchor.originY}px`;
  frame.style.transform = `translate3d(0, 0, 0) scale(${scale})`;
  frame.style.willChange = "transform";
  frame.style.backfaceVisibility = "hidden";
}

function clearLiveZoomTransform(frame: HTMLDivElement | null) {
  if (!frame) return;
  frame.style.removeProperty("transform");
  frame.style.removeProperty("transform-origin");
  frame.style.removeProperty("will-change");
  frame.style.removeProperty("backface-visibility");
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
  renderedImageSize: { width: number; height: number } | null;
  frameRef: (node: HTMLDivElement | null) => void;
  onLoad: (image: HTMLImageElement) => void;
  onError?: () => void;
  focusAnalysis?: FocusAnalysis | null;
  cameraAfMetadata?: CameraAfMetadata | null;
  children?: ReactNode;
}

const ZoomableImageElement = memo(function ZoomableImageElement({
  entry,
  src,
  renderedImageSize,
  frameRef,
  onLoad,
  onError,
  focusAnalysis,
  cameraAfMetadata,
  children,
}: ZoomableImageElementProps) {
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const focusRegions =
    cameraAfRegions ?? (focusAnalysis?.kind === "full-frame" ? [] : (focusAnalysis?.regions ?? []));
  const frameStyle: CSSProperties = {
    ...(renderedImageSize
      ? {
          // Settled zoom uses real layout pixels so WebKit resamples from the
          // decoded source instead of retaining a small promoted layer.
          width: `${renderedImageSize.width}px`,
          height: `${renderedImageSize.height}px`,
          maxWidth: "none",
          maxHeight: "none",
        }
      : {}),
  };

  return (
    <div ref={frameRef} className="relative shrink-0" style={frameStyle}>
      <img
        key={entry.path}
        src={src}
        alt={entry.name}
        width={renderedImageSize?.width}
        height={renderedImageSize?.height}
        className={`${renderedImageSize ? "h-full w-full" : "h-auto max-h-full w-auto max-w-full"} rounded-lg shadow-lg select-none`}
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
      {children}
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
  const [previewViewport, setPreviewViewport] = useState({ width: 0, height: 0 });
  const [settledImageZoom, setSettledImageZoom] = useState(1);
  const imageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageFrameRef = useRef<HTMLDivElement | null>(null);
  const imageZoomRef = useRef(1);
  const settledImageZoomRef = useRef(1);
  const pendingZoomRef = useRef<number | null>(null);
  const zoomAnimationFrameRef = useRef<number | null>(null);
  const commitZoomTimeoutRef = useRef<number | null>(null);
  const zoomInteractionTimeoutRef = useRef<number | null>(null);
  const gestureAnchorRef = useRef<ZoomGestureAnchor | null>(null);
  const settleAnchorRef = useRef<ZoomGestureAnchor | null>(null);
  const isZoomGestureActiveRef = useRef(false);
  const canInspectSharpness = isAnalyzablePhoto(entry);
  const sharpnessInspector = useSharpnessInspector({
    entry,
    displayedDimensions: imageDimensions,
    autoStart: canInspectSharpness,
  });
  const registerSharpnessPreviewImage = sharpnessInspector.registerPreviewImage;
  const displayedFocusAnalysis = sharpnessInspector.enabled ? null : focusAnalysis;
  const focusRegions =
    cameraAfRegions ??
    (displayedFocusAnalysis?.kind === "full-frame" ? [] : (displayedFocusAnalysis?.regions ?? []));
  const handleDisplayedImageLoad = useCallback(
    (image: HTMLImageElement) => {
      onImageLoadDimensions(image);
      if (canInspectSharpness) {
        registerSharpnessPreviewImage(image);
      }
    },
    [canInspectSharpness, onImageLoadDimensions, registerSharpnessPreviewImage]
  );

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

  const renderedImageSize = useMemo(() => {
    if (!fittedImageSize) {
      return null;
    }

    return {
      width: Math.max(1, Math.round(fittedImageSize.width * settledImageZoom)),
      height: Math.max(1, Math.round(fittedImageSize.height * settledImageZoom)),
    };
  }, [fittedImageSize, settledImageZoom]);

  const zoomedCanvasSize = useMemo(() => {
    if (!renderedImageSize) {
      return null;
    }

    return {
      width: Math.max(imageViewportSize.width, renderedImageSize.width),
      height: Math.max(imageViewportSize.height, renderedImageSize.height),
    };
  }, [renderedImageSize, imageViewportSize.height, imageViewportSize.width]);

  const registerZoomFrame = useCallback((node: HTMLDivElement | null) => {
    imageFrameRef.current = node;
    const anchor = gestureAnchorRef.current;
    if (!node || !anchor || !isZoomGestureActiveRef.current) return;

    const liveZoom = pendingZoomRef.current ?? imageZoomRef.current;
    applyLiveZoomTransform(node, liveZoom / settledImageZoomRef.current, anchor);
  }, []);

  useEffect(() => {
    const viewport = imageViewportRef.current;
    if (!viewport) {
      return;
    }

    let resizeFrame: number | null = null;
    const updateSize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        setPreviewViewport((current) =>
          current.width === width && current.height === height ? current : { width, height }
        );
      });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);

    return () => {
      observer.disconnect();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
    };
  }, [entry.path]);

  useLayoutEffect(() => {
    settledImageZoomRef.current = settledImageZoom;
    clearLiveZoomTransform(imageFrameRef.current);

    const adjustment = settleAnchorRef.current;
    const viewport = imageViewportRef.current;
    const frame = imageFrameRef.current;
    if (adjustment && viewport && frame) {
      const viewportRect = viewport.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const nextScrollLeft = Math.max(
        0,
        viewport.scrollLeft +
          frameRect.left +
          frameRect.width * adjustment.imageRatioX -
          (viewportRect.left + adjustment.viewportX)
      );
      const nextScrollTop = Math.max(
        0,
        viewport.scrollTop +
          frameRect.top +
          frameRect.height * adjustment.imageRatioY -
          (viewportRect.top + adjustment.viewportY)
      );

      if (Math.abs(nextScrollLeft - viewport.scrollLeft) >= MIN_SCROLL_ADJUST_DELTA) {
        viewport.scrollLeft = nextScrollLeft;
      }
      if (Math.abs(nextScrollTop - viewport.scrollTop) >= MIN_SCROLL_ADJUST_DELTA) {
        viewport.scrollTop = nextScrollTop;
      }
    }

    settleAnchorRef.current = null;
    gestureAnchorRef.current = null;
    isZoomGestureActiveRef.current = false;
  }, [settledImageZoom]);

  const updateImageZoom = useCallback(
    (nextZoom: number, anchor?: { clientX: number; clientY: number }) => {
      if (!Number.isFinite(nextZoom)) return;
      const clampedZoom = clampZoom(nextZoom);
      const currentZoom = pendingZoomRef.current ?? imageZoomRef.current;
      if (clampedZoom === currentZoom) return;

      if (commitZoomTimeoutRef.current !== null) {
        window.clearTimeout(commitZoomTimeoutRef.current);
        commitZoomTimeoutRef.current = null;
      }

      if (!isZoomGestureActiveRef.current) {
        const viewport = imageViewportRef.current;
        const frame = imageFrameRef.current;
        if (viewport && frame) {
          const viewportRect = viewport.getBoundingClientRect();
          const frameRect = frame.getBoundingClientRect();
          const clientX = anchor?.clientX ?? viewportRect.left + viewportRect.width / 2;
          const clientY = anchor?.clientY ?? viewportRect.top + viewportRect.height / 2;
          const originX = clientX - frameRect.left;
          const originY = clientY - frameRect.top;
          gestureAnchorRef.current = {
            imageRatioX: originX / Math.max(1, frameRect.width),
            imageRatioY: originY / Math.max(1, frameRect.height),
            originX,
            originY,
            viewportX: clientX - viewportRect.left,
            viewportY: clientY - viewportRect.top,
          };
          isZoomGestureActiveRef.current = true;
        }
      }

      pendingZoomRef.current = clampedZoom;
      if (zoomInteractionTimeoutRef.current !== null) {
        window.clearTimeout(zoomInteractionTimeoutRef.current);
      }
      zoomInteractionTimeoutRef.current = window.setTimeout(() => {
        zoomInteractionTimeoutRef.current = null;
        if (zoomAnimationFrameRef.current !== null) {
          window.cancelAnimationFrame(zoomAnimationFrameRef.current);
          zoomAnimationFrameRef.current = null;
        }

        const finalZoom = pendingZoomRef.current ?? clampedZoom;
        pendingZoomRef.current = null;
        imageZoomRef.current = finalZoom;
        onZoomDisplayChange(finalZoom);
        settleAnchorRef.current = gestureAnchorRef.current;

        if (Math.abs(finalZoom - settledImageZoomRef.current) < 0.001) {
          clearLiveZoomTransform(imageFrameRef.current);
          settleAnchorRef.current = null;
          gestureAnchorRef.current = null;
          isZoomGestureActiveRef.current = false;
        } else {
          setSettledImageZoom(finalZoom);
        }

        commitZoomTimeoutRef.current = window.setTimeout(() => {
          commitZoomTimeoutRef.current = null;
          onCommittedZoomChange(finalZoom);
        }, 200);
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
        imageZoomRef.current = pendingZoom;
        const frame = imageFrameRef.current;
        const gestureAnchor = gestureAnchorRef.current;
        if (frame && gestureAnchor) {
          applyLiveZoomTransform(frame, pendingZoom / settledImageZoomRef.current, gestureAnchor);
        }
        onZoomDisplayChange(pendingZoom);
      });
    },
    [onCommittedZoomChange, onZoomDisplayChange]
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

  const sharpnessOverlay = canInspectSharpness ? (
    <SharpnessSelectionOverlay
      enabled={sharpnessInspector.enabled}
      selectionMode={sharpnessInspector.selectionMode}
      selection={sharpnessInspector.selection}
      result={sharpnessInspector.result}
      onSelectionCommit={sharpnessInspector.commitSelection}
      onSelectionTooSmall={sharpnessInspector.reportTooSmall}
      onAnalyzeFullImage={sharpnessInspector.analyzeFullImage}
      onEscape={sharpnessInspector.escape}
    />
  ) : null;

  return (
    <div className="relative h-full w-full">
      {canInspectSharpness ? (
        <SharpnessInspectorToolbar
          enabled={sharpnessInspector.enabled}
          status={sharpnessInspector.status}
          selectionMode={sharpnessInspector.selectionMode}
          selection={sharpnessInspector.selection}
          result={sharpnessInspector.result}
          onToggle={sharpnessInspector.toggle}
          onAnalyzeFullImage={sharpnessInspector.analyzeFullImage}
          onResetSelection={sharpnessInspector.resetSelection}
        />
      ) : null}
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
                entry={entry}
                src={nativePreviewSrc}
                renderedImageSize={renderedImageSize}
                frameRef={registerZoomFrame}
                onLoad={handleDisplayedImageLoad}
                focusAnalysis={displayedFocusAnalysis}
                cameraAfMetadata={cameraAfMetadata}
              >
                {sharpnessOverlay}
              </ZoomableImageElement>
            ) : (
              <div
                ref={registerZoomFrame}
                className="relative shrink-0"
                style={
                  renderedImageSize
                    ? {
                        width: `${renderedImageSize.width}px`,
                        height: `${renderedImageSize.height}px`,
                      }
                    : undefined
                }
              >
                <FileThumbnail
                  entry={entry}
                  size={320}
                  requestSizeOverride={progressivePreviewRequestSize}
                  className={`${renderedImageSize ? "h-full w-full" : "h-auto max-h-full w-auto max-w-full"} rounded-lg object-contain shadow-lg`}
                  fallbackClassName="text-muted-foreground h-40 w-40"
                  onImageLoad={handleDisplayedImageLoad}
                />
                {renderedImageSize &&
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
                {sharpnessOverlay}
              </div>
            )
          ) : (
            <ZoomableImageElement
              entry={entry}
              src={fallbackSrc || fileSrc || ""}
              renderedImageSize={renderedImageSize}
              frameRef={registerZoomFrame}
              onLoad={handleDisplayedImageLoad}
              onError={onBrowserImageError}
              focusAnalysis={displayedFocusAnalysis}
              cameraAfMetadata={cameraAfMetadata}
            >
              {sharpnessOverlay}
            </ZoomableImageElement>
          )}
        </div>
      </div>
    </div>
  );
});

export function QuickLook({ entry, entries, photoAnalysis, onClose, onNavigate }: QuickLookProps) {
  const { t } = useTranslation();
  const isOpen = Boolean(entry);
  const entryPath = entry?.path ?? null;
  const entryModified = entry?.modified ?? 0;
  const entrySize = entry?.size ?? 0;
  const entryExtension = entry?.extension ?? "";
  const entryIdentity = entry ? `${entryPath}\u0000${entryModified}\u0000${entrySize}` : null;

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
  const nativePreviewSizeRef = useRef(0);
  const nativePreviewTargetSizeRef = useRef(0);
  const zoomIndicatorRef = useRef<HTMLSpanElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });

    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

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
  const cameraAfMetadata = useCameraAfMetadata(entry, previewType === "image", "interactive");
  const photoMetadata = usePhotoMetadata(entry, previewType === "image");
  const photoMetadataSummary = getPhotoMetadataSummary(photoMetadata);

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
        void loadFileThumbnail(
          cacheKey,
          candidate.path,
          768,
          true,
          controller.signal,
          "background",
          false,
          false
        );
      }
    }, 90);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [entry, nextEntry, previewType, previousEntry]);

  const nativePreviewRequestSize = useMemo(() => {
    if (previewType !== "image" || !entryPath) {
      return 768;
    }

    const viewportMax = Math.max(viewportSize.width, viewportSize.height);
    const devicePixelRatio =
      typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const zoomScale = previewZoomFactor;
    const baseSize = snapThumbnailSize(
      Math.max(1024, Math.round(viewportMax * 0.86 * devicePixelRatio * zoomScale))
    );
    const extension = entryExtension.toLowerCase();

    if (isRawImage) {
      // RAW 预览直接请求一张足够清晰的图，避免先显示 384px 缩略图后一直
      // 停留在模糊状态；列表缩略图仍然小尺寸，空格预览只解码当前文件。
      // Keep the first full RAW frame above the 1.5x zoom threshold even on a
      // 1x external display; a 1536px render is visibly soft in a large Quick
      // Look window before the next zoom-triggered request arrives.
      return Math.min(MAX_RAW_PREVIEW_SIZE, Math.max(3072, baseSize));
    }

    if (extension === "psd") {
      if (entrySize > 400 * 1024 * 1024) {
        return Math.min(2048, baseSize);
      }
      if (entrySize > 160 * 1024 * 1024) {
        return Math.min(3072, Math.max(1536, baseSize));
      }
      return Math.min(4096, Math.max(2048, baseSize));
    }

    return baseSize;
  }, [
    entryExtension,
    entryPath,
    entrySize,
    isRawImage,
    previewType,
    previewZoomFactor,
    viewportSize.height,
    viewportSize.width,
  ]);

  const progressivePreviewRequestSize = useMemo(() => {
    if (previewType !== "image" || !entryPath) {
      return 384;
    }

    const extension = entryExtension.toLowerCase();
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
      return entrySize > 120 * 1024 * 1024 ? 512 : 768;
    }

    return 384;
  }, [
    entryExtension,
    entryPath,
    entrySize,
    isRawImage,
    previewType,
    viewportSize.height,
    viewportSize.width,
  ]);

  const cachedNativePreview = useMemo(() => {
    if (!entryPath) {
      return null;
    }

    const cached = getLargestCachedFileThumbnail(entryPath, entryModified, entrySize);
    return cached
      ? { size: cached.requestSize, src: `data:image/png;base64,${cached.base64}` }
      : null;
  }, [entryModified, entryPath, entrySize]);

  const dialogStyle = useMemo<CSSProperties | undefined>(() => {
    if (previewType !== "image" || !imageDimensions) {
      return undefined;
    }

    const HEADER_HEIGHT = 48;
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

  const updateImageDimensions = useCallback((nextDimensions: ImageDimensions) => {
    if (nextDimensions.width <= 0 || nextDimensions.height <= 0) return;
    setImageDimensions((current) => {
      if (!current) return nextDimensions;
      const currentAspect = current.width / current.height;
      const nextAspect = nextDimensions.width / nextDimensions.height;
      const relativeDifference =
        Math.abs(currentAspect - nextAspect) / Math.max(currentAspect, nextAspect);
      // Progressive RAW frames commonly change pixel dimensions while keeping
      // the same image geometry. Preserve the fitted layout in that case.
      return relativeDifference < 0.002 ? current : nextDimensions;
    });
  }, []);

  // 当 entry 变化时，重置错误状态
  useEffect(() => {
    setError(null);
    setTextContent(null);
    setFallbackSrc(null);
    setUseNativeImagePreview(false);
    setImageDimensions(null);
    setNativePreviewSrc(null);
    setCommittedZoom(1);
    nativePreviewSizeRef.current = 0;
    nativePreviewTargetSizeRef.current = 0;
  }, [entryIdentity]);

  const updateZoomIndicator = useCallback((zoom: number | null) => {
    if (!zoomIndicatorRef.current) {
      return;
    }
    zoomIndicatorRef.current.textContent = zoom === null ? "" : ` ${Math.round(zoom * 100)}%`;
  }, []);

  useEffect(() => {
    updateZoomIndicator(previewType === "image" ? 1 : null);
  }, [entryIdentity, previewType, updateZoomIndicator]);

  useEffect(() => {
    let resizeFrame: number | null = null;
    const handleResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        const width = window.innerWidth;
        const height = window.innerHeight;
        setViewportSize((current) =>
          current.width === width && current.height === height ? current : { width, height }
        );
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
    };
  }, []);

  // ESC 关闭 + 媒体清理
  useEffect(() => {
    if (!entry) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const eventTarget = e.target instanceof Element ? e.target : null;
      const activeElement =
        document.activeElement instanceof Element ? document.activeElement : null;
      const quickLookIsActive = [eventTarget, activeElement].some((element) =>
        element?.closest('[data-keyboard-scope="quick-look"]')
      );
      if (
        e.defaultPrevented ||
        shouldIgnoreKeyboardCommand(e, {
          allowOverlaySelector: '[data-keyboard-scope="quick-look"]',
        }) ||
        !quickLookIsActive ||
        isInteractiveKeyboardTarget(eventTarget) ||
        isInteractiveKeyboardTarget(activeElement)
      ) {
        return;
      }

      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusableElements = Array.from(
          dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)
        );
        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];
        const activeElement = document.activeElement;
        if (!dialog.contains(activeElement)) {
          e.preventDefault();
          firstFocusable.focus();
          return;
        }
        if (e.shiftKey && (activeElement === firstFocusable || activeElement === dialog)) {
          e.preventDefault();
          lastFocusable.focus();
          return;
        }
        if (!e.shiftKey && activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable.focus();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
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
    if (!entryPath || previewType !== "image" || isRawImage) {
      return;
    }

    let cancelled = false;

    invoke<ImageDimensions>("read_image_dimensions", { path: entryPath })
      .then((dimensions) => {
        if (!cancelled && dimensions.width > 0 && dimensions.height > 0) {
          updateImageDimensions(dimensions);
        }
      })
      .catch(() => {
        // Keep browser onLoad as a fallback for supported images.
      });

    return () => {
      cancelled = true;
    };
  }, [entryIdentity, entryPath, isRawImage, previewType, updateImageDimensions]);

  useEffect(() => {
    if (
      !entryPath ||
      previewType !== "image" ||
      (isBrowserSupportedImage(entryExtension) && !useNativeImagePreview)
    ) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const cachePrefix = `file:${entryPath}:${entryModified}:${entrySize}:`;
    const progressiveCacheKey = `${cachePrefix}${progressivePreviewRequestSize}`;
    const fullCacheKey = `${cachePrefix}${nativePreviewRequestSize}`;

    const applyPreviewSource = (src: string, requestSize: number) => {
      if (cancelled || requestSize < nativePreviewSizeRef.current) return;
      nativePreviewSizeRef.current = requestSize;
      setNativePreviewSrc((current) => (current === src ? current : src));
    };

    if (cachedNativePreview?.src) {
      applyPreviewSource(cachedNativePreview.src, cachedNativePreview.size);
    }

    const loadPreview = (cacheKey: string, requestSize: number) => {
      const availableSize = Math.max(
        nativePreviewSizeRef.current,
        nativePreviewTargetSizeRef.current
      );
      if (!shouldUpgradeNativePreview(availableSize, requestSize)) {
        return Promise.resolve();
      }

      nativePreviewTargetSizeRef.current = requestSize;
      return loadFileThumbnail(
        cacheKey,
        entryPath,
        requestSize,
        true,
        controller.signal,
        "interactive",
        false,
        false
      )
        .then((base64) => {
          if (base64) {
            applyPreviewSource(`data:image/png;base64,${base64}`, requestSize);
          }
        })
        .finally(() => {
          if (nativePreviewTargetSizeRef.current === requestSize) {
            nativePreviewTargetSizeRef.current = nativePreviewSizeRef.current;
          }
        });
    };

    const loadFullPreview = () => loadPreview(fullCacheKey, nativePreviewRequestSize);
    const availableSize = Math.max(
      nativePreviewSizeRef.current,
      nativePreviewTargetSizeRef.current
    );

    // Decode at most one useful upgrade at a time. Small zoom and resize
    // changes reuse the current frame; a new native decode starts only after
    // a meaningful resolution step.
    if (shouldUpgradeNativePreview(availableSize, progressivePreviewRequestSize)) {
      void loadPreview(progressiveCacheKey, progressivePreviewRequestSize).finally(() => {
        if (!cancelled) void loadFullPreview();
      });
    } else {
      void loadFullPreview();
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (nativePreviewTargetSizeRef.current > nativePreviewSizeRef.current) {
        nativePreviewTargetSizeRef.current = nativePreviewSizeRef.current;
      }
    };
  }, [
    cachedNativePreview,
    entryExtension,
    entryIdentity,
    entryModified,
    entryPath,
    entrySize,
    nativePreviewRequestSize,
    previewType,
    progressivePreviewRequestSize,
    useNativeImagePreview,
  ]);

  useEffect(() => {
    // 只有文本文件才需要加载内容
    if (!entryPath || previewType !== "text") {
      return;
    }

    let cancelled = false;

    const loadText = async () => {
      try {
        setLoading(true);
        setError(null);
        const content = await invoke<string>("read_text_file", {
          path: entryPath,
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
  }, [entryIdentity, entryPath, previewType]);

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

  const handleImageLoadDimensions = useCallback(
    (image: HTMLImageElement) => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        updateImageDimensions({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      }
    },
    [updateImageDimensions]
  );

  const handleBrowserImageError = useCallback(() => {
    if (!entryPath) {
      return;
    }

    if (fallbackSrc) {
      setUseNativeImagePreview(true);
      setError(null);
      return;
    }

    invoke<string>("read_image_base64", { path: entryPath })
      .then((base64) => {
        setFallbackSrc(base64);
        setError(null);
      })
      .catch(() => {
        setUseNativeImagePreview(true);
        setError(null);
      });
  }, [entryPath, fallbackSrc]);

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
                key={`${entry.path}:${entry.modified ?? 0}:${entry.size}`}
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
        ref={dialogRef}
        className={`bg-background/80 text-foreground animate-in fade-in zoom-in-95 relative flex ${dialogSizeClass} flex-col overflow-hidden rounded-lg border border-black/8 shadow-xl backdrop-blur-md motion-reduce:animate-none`}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        data-keyboard-scope="quick-look"
        aria-label={t("common.quick_look.preview")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title Bar */}
        <div className="bg-muted/25 relative flex items-center justify-between border-b border-black/6 px-3 py-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.quick_look.close")}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:outline-none dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            {canNavigate ? (
              <>
                <button
                  type="button"
                  onClick={() => previousEntry && onNavigate(previousEntry)}
                  disabled={!previousEntry}
                  aria-label={t("common.quick_look.previous")}
                  className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 focus-visible:ring-ring flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:outline-none disabled:hover:bg-transparent dark:hover:bg-white/10"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => nextEntry && onNavigate(nextEntry)}
                  disabled={!nextEntry}
                  aria-label={t("common.quick_look.next")}
                  className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 focus-visible:ring-ring flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:outline-none disabled:hover:bg-transparent dark:hover:bg-white/10"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
          <div className="pointer-events-none absolute left-1/2 max-w-[50%] min-w-0 -translate-x-1/2 text-center text-sm font-medium">
            <div className="truncate" title={entry.name}>
              {entry.name}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("common.quick_look.preview")}
              <span ref={zoomIndicatorRef}>{previewType === "image" ? " 100%" : ""}</span>
            </div>
            {photoMetadataSummary?.camera.length ? (
              <div
                className="text-muted-foreground truncate text-[10px]"
                title={photoMetadataSummary.camera.join(" · ")}
              >
                {photoMetadataSummary.camera.join(" · ")}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleOpen}
            className="text-primary hover:text-primary/80 focus-visible:ring-ring flex h-8 items-center gap-1 rounded-md px-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
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
