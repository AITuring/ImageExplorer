import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  X,
  ExternalLink,
  File,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Check,
  XCircle,
  Star,
  ScanFace,
  Archive,
  Folder,
  PackageOpen,
} from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FocusRegionOverlay } from "@/components/FocusRegionOverlay";
import { PhotoHistogram } from "@/components/PhotoHistogram";
import { SharpnessInspectorToolbar } from "@/components/SharpnessInspectorToolbar";
import { SharpnessSelectionOverlay } from "@/components/SharpnessSelectionOverlay";
import {
  buildFileThumbnailUrl,
  buildRawEmbeddedJpegUrl,
  getLargestLoadedFileThumbnailUrl,
  loadHtmlImage,
} from "@/lib/iconCache";
import { preloadNeighborEntries } from "@/lib/imagePreload";
import { useCameraAfMetadata } from "@/hooks/useCameraAfMetadata";
import { useSharpnessInspector } from "@/hooks/useSharpnessInspector";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import {
  formatAperture,
  formatFocalLength,
  formatShutterSpeed,
  type PhotoMetadata,
} from "@/lib/photoMetadata";
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
import { FINDER_TAG_PRESETS } from "@/lib/finderTags";
import { extractHistogramFromImageElement, type PhotoHistogramData } from "@/lib/histogramAnalysis";
import { DEFAULT_CULLING_STATE, type PhotoCullingState, type PhotoFlag } from "@/lib/photoCulling";
import {
  centerCameraOnNormalizedPoint,
  clampQuickLookCamera,
  clampQuickLookZoom,
  getMinimapViewportRect,
  panCameraBy,
  zoomCameraAtPoint,
  type QuickLookCamera,
} from "@/lib/quickLookCamera";

interface QuickLookProps {
  entry: FileEntry | null;
  entries: FileEntry[];
  entryAnalysis?: PhotoAnalysisRecord;
  photoAnalysis?: ReadonlyMap<string, PhotoAnalysisRecord>;
  cullingState?: PhotoCullingState;
  autoAdvance?: boolean;
  onClose: () => void;
  onNavigate: (entry: FileEntry) => void;
  onToggleTag?: (entry: FileEntry, tag: string) => void;
  onSetRating?: (entry: FileEntry, rating: number) => void;
  onSetFlag?: (entry: FileEntry, flag: PhotoFlag) => void;
  onDelete?: (entry: FileEntry) => Promise<void>;
  onExtract?: (entry: FileEntry) => void;
}

type PreviewType = "text" | "image" | "video" | "audio" | "pdf" | "zip" | "icon";

interface ZipEntryInfo {
  name: string;
  isDir: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

interface ZipArchivePreview {
  totalEntries: number;
  totalCompressed: number;
  totalUncompressed: number;
  truncated: boolean;
  entries: ZipEntryInfo[];
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface DetectedFace {
  x: number;
  y: number;
  width: number;
  height: number;
  eyeX: number;
  eyeY: number;
  leftEye?: [number, number] | null;
  rightEye?: [number, number] | null;
}

const THUMBNAIL_SIZE_STEPS = [384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192];
const MAX_RAW_PREVIEW_SIZE = 8192;
const ARW_INTERACTIVE_PREVIEW_SIZE = 4096;
const ARW_GESTURE_PREVIEW_SIZE = 1536;
const RAW_EXTENSIONS = new Set(RAW_IMAGE_EXTENSIONS);
const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function snapThumbnailSize(value: number) {
  return (
    THUMBNAIL_SIZE_STEPS.find((step) => value <= step) ??
    THUMBNAIL_SIZE_STEPS[THUMBNAIL_SIZE_STEPS.length - 1]
  );
}

function getPreviewZoomFactor(value: number) {
  return Math.min(4, Math.max(1, value));
}

function shouldUpgradeNativePreview(currentSize: number, requestedSize: number) {
  if (currentSize <= 0) return true;
  if (requestedSize <= currentSize) return false;
  return requestedSize / currentSize >= 1.2;
}

interface SafariGestureEvent extends UIEvent {
  scale: number;
  rotation: number;
  clientX: number;
  clientY: number;
}

const QuickLookPhotoFooter = memo(function QuickLookPhotoFooter({
  metadata,
  analysis,
  cameraAfMetadata,
  histogram,
  showClippingOverlay,
  onToggleClippingOverlay,
}: {
  metadata: PhotoMetadata | null;
  analysis?: PhotoAnalysisRecord;
  cameraAfMetadata?: CameraAfMetadata | null;
  histogram: PhotoHistogramData | null;
  showClippingOverlay: boolean;
  onToggleClippingOverlay: () => void;
}) {
  const { t } = useTranslation();
  const iso = metadata?.iso?.match(/\d+(?:\.\d+)?/)?.[0] ?? null;
  const exposureItems = [
    { label: "ISO", value: iso ? `ISO ${iso}` : null },
    { label: t("file_list.details.aperture"), value: formatAperture(metadata?.aperture ?? null) },
    {
      label: t("file_list.details.shutter"),
      value: formatShutterSpeed(metadata?.shutterSpeed ?? null),
    },
    {
      label: t("file_list.details.focal"),
      value: formatFocalLength(metadata?.focalLength ?? null),
    },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value));

  const cameraModel = metadata?.model || metadata?.make || null;
  const lensModel = metadata?.lens || null;
  const equipmentText = [cameraModel, lensModel].filter(Boolean).join(" · ");

  const focusAnalysis = analysis?.focusAnalysis;
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const regions = cameraAfRegions ?? focusAnalysis?.regions ?? [];
  const region = regions[0];

  let focusBadgeText: string | null = null;
  let focusTooltip: string | undefined;
  if (cameraAfMetadata?.source === "camera-maker-note" && cameraAfRegions?.length) {
    focusBadgeText = t("common.quick_look.focus_camera_af_regions", {
      count: cameraAfRegions.length,
    });
    focusTooltip = [
      t("common.quick_look.focus_camera_af"),
      focusBadgeText,
      region
        ? t("common.quick_look.focus_camera_af_size", {
            width: Math.round(region.width * 100),
            height: Math.round(region.height * 100),
          })
        : null,
      cameraAfMetadata.areaMode,
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (focusAnalysis?.kind === "full-frame") {
    const confidence = Math.round(focusAnalysis.confidence * 100);
    focusBadgeText = `${t("common.quick_look.focus_full_frame")} · ${confidence}%`;
    focusTooltip = `${t("common.quick_look.focus_data")} · ${focusBadgeText} · ${t("common.quick_look.focus_method")}`;
  } else if (focusAnalysis && region) {
    const confidence = Math.round(focusAnalysis.confidence * 100);
    focusBadgeText = `${t("common.quick_look.focus_regions", { count: regions.length })} · ${confidence}%`;
    focusTooltip = [
      t("common.quick_look.focus_data"),
      t("common.quick_look.focus_regions", { count: regions.length }),
      t("common.quick_look.focus_region_size", {
        width: Math.round(region.width * 100),
        height: Math.round(region.height * 100),
      }),
      t("common.quick_look.focus_confidence", { value: confidence }),
      t("common.quick_look.focus_method"),
    ].join(" · ");
  }

  return (
    <footer
      className="border-border/50 bg-muted/25 flex h-10 w-full shrink-0 items-center justify-between gap-3 rounded-md border px-2.5 pr-6 text-xs"
      aria-label={t("file_list.details.shooting")}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
        {exposureItems.length > 0 && (
          <div className="text-foreground flex shrink-0 items-center gap-2 font-mono text-xs font-medium whitespace-nowrap tabular-nums">
            {exposureItems.map(({ label, value }, idx) => (
              <span key={label} title={`${label}: ${value}`} className="inline-flex items-center">
                {idx > 0 && <span className="text-muted-foreground/45 mr-2">·</span>}
                {value}
              </span>
            ))}
          </div>
        )}
        {equipmentText && (
          <>
            {exposureItems.length > 0 && (
              <span className="bg-border/60 h-3.5 w-px shrink-0" aria-hidden="true" />
            )}
            <div
              className="text-muted-foreground min-w-0 truncate text-[11px]"
              title={equipmentText}
            >
              {cameraModel && <span className="text-foreground/90 font-medium">{cameraModel}</span>}
              {cameraModel && lensModel && <span className="text-muted-foreground/50 mx-1">·</span>}
              {lensModel && <span>{lensModel}</span>}
            </div>
          </>
        )}
        {focusBadgeText && (
          <>
            <span className="bg-border/60 hidden h-3.5 w-px shrink-0 lg:block" aria-hidden="true" />
            <span
              className="bg-secondary/45 text-muted-foreground hidden shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap tabular-nums lg:inline-flex"
              title={focusTooltip}
              role="status"
              aria-live="polite"
            >
              {focusBadgeText}
            </span>
          </>
        )}
      </div>

      {histogram && (
        <div className="border-border/50 flex shrink-0 items-center border-l pl-2.5">
          <PhotoHistogram
            histogram={histogram}
            showClippingOverlay={showClippingOverlay}
            onToggleClippingOverlay={onToggleClippingOverlay}
            inline
          />
        </div>
      )}
    </footer>
  );
});

interface ZoomPreviewActions {
  toggleOneToOne: () => void;
  zoomToNormalizedPoint: (normX: number, normY: number, targetZoom?: number) => void;
}

interface ZoomableImagePreviewProps {
  entry: FileEntry;
  viewportSize: { width: number; height: number };
  imageDimensions: ImageDimensions | null;
  nativePreviewSrc: string | null;
  interactionPreviewSrc: string | null;
  minimapSrc: string | null;
  fallbackSrc: string | null;
  fileSrc: string | null;
  clippingMaskUrl?: string | null;
  detectedFaces?: DetectedFace[];
  activeFaceIndex?: number;
  zoomActionsRef?: MutableRefObject<ZoomPreviewActions | null>;
  useNativeImagePreview: boolean;
  progressivePreviewRequestSize: number;
  sharpnessAutoReady: boolean;
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
  interactionSrc?: string | null;
  clippingMaskUrl?: string | null;
  detectedFaces?: DetectedFace[];
  activeFaceIndex?: number;
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
  clippingMaskUrl,
  detectedFaces,
  activeFaceIndex = -1,
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
  const frameStyle: CSSProperties = renderedImageSize
    ? {
        position: "absolute",
        left: 0,
        top: 0,
        width: `${renderedImageSize.width}px`,
        height: `${renderedImageSize.height}px`,
        maxWidth: "none",
        maxHeight: "none",
        transformOrigin: "0 0",
        willChange: "transform",
        backfaceVisibility: "hidden",
      }
    : {
        position: "relative",
        maxWidth: "100%",
        maxHeight: "100%",
      };

  return (
    <div ref={frameRef} className="quick-look-image-frame shrink-0" style={frameStyle}>
      <img
        key={entry.path}
        src={src}
        crossOrigin={src.startsWith("thumb:") ? "anonymous" : undefined}
        alt={entry.name}
        width={renderedImageSize?.width}
        height={renderedImageSize?.height}
        className={`quick-look-full-image ${renderedImageSize ? "h-full w-full" : "h-auto max-h-full w-auto max-w-full"} rounded-md object-contain select-none`}
        decoding="async"
        draggable={false}
        onLoad={(event) => onLoad(event.currentTarget)}
        onError={onError}
      />
      {clippingMaskUrl ? (
        <img
          src={clippingMaskUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full rounded-md object-contain select-none"
          draggable={false}
        />
      ) : null}
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
      {detectedFaces && detectedFaces.length > 0
        ? detectedFaces.map((face, idx) => {
            const isActive = idx === activeFaceIndex;
            return (
              <div
                key={`face-${idx}-${face.x.toFixed(3)}-${face.y.toFixed(3)}`}
                className="pointer-events-none absolute inset-0"
              >
                <div
                  className={`absolute rounded-sm border transition-colors ${
                    isActive
                      ? "border-emerald-400 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
                      : "border-emerald-400/50"
                  }`}
                  style={{
                    left: `${face.x * 100}%`,
                    top: `${face.y * 100}%`,
                    width: `${face.width * 100}%`,
                    height: `${face.height * 100}%`,
                  }}
                />
                <div
                  className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
                    isActive
                      ? "border-emerald-300 bg-emerald-400/30 shadow-[0_0_6px_rgba(16,185,129,0.9)]"
                      : "border-emerald-300/70"
                  }`}
                  style={{
                    left: `${face.eyeX * 100}%`,
                    top: `${face.eyeY * 100}%`,
                  }}
                />
              </div>
            );
          })
        : null}
      {children}
    </div>
  );
});

const ZoomableImagePreview = memo(function ZoomableImagePreview({
  entry,
  viewportSize,
  imageDimensions,
  nativePreviewSrc,
  minimapSrc,
  fallbackSrc,
  fileSrc,
  clippingMaskUrl,
  detectedFaces,
  activeFaceIndex = -1,
  zoomActionsRef,
  useNativeImagePreview,
  progressivePreviewRequestSize,
  sharpnessAutoReady,
  onImageLoadDimensions,
  onBrowserImageError,
  onZoomDisplayChange,
  onCommittedZoomChange,
  focusAnalysis,
  cameraAfMetadata,
}: ZoomableImagePreviewProps) {
  const { t } = useTranslation();
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const [previewViewport, setPreviewViewport] = useState({ width: 0, height: 0 });
  const [isZoomed, setIsZoomed] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);
  const imageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageFrameRef = useRef<HTMLDivElement | null>(null);
  const minimapWindowRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<QuickLookCamera>({ scale: 1, tx: 0, ty: 0 });
  const renderRafRef = useRef<number | null>(null);
  const animRafRef = useRef<number | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  const nativeGestureActiveRef = useRef(false);
  const nativeGestureBaseScaleRef = useRef(1);
  const panStartRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    tx: number;
    ty: number;
  } | null>(null);

  const canInspectSharpness = isAnalyzablePhoto(entry);
  // Keep sharpness peaking strictly on-demand so browsing and zooming RAWs
  // never stalls the main thread with a 64MB full-frame getImageData() copy.
  const sharpnessInspector = useSharpnessInspector({
    entry,
    displayedDimensions: imageDimensions,
    autoStart: false,
  });
  const registerSharpnessPreviewImage = sharpnessInspector.registerPreviewImage;
  const displayedFocusAnalysis = sharpnessInspector.enabled ? null : focusAnalysis;
  const focusRegions =
    cameraAfRegions ??
    (displayedFocusAnalysis?.kind === "full-frame" ? [] : (displayedFocusAnalysis?.regions ?? []));
  const handleDisplayedImageLoad = useCallback(
    (image: HTMLImageElement) => {
      onImageLoadDimensions(image);
      if (canInspectSharpness && sharpnessAutoReady) {
        registerSharpnessPreviewImage(image);
      }
    },
    [canInspectSharpness, onImageLoadDimensions, registerSharpnessPreviewImage, sharpnessAutoReady]
  );

  const imageViewportSize = useMemo(() => {
    if (previewViewport.width > 0 && previewViewport.height > 0) {
      return previewViewport;
    }
    return {
      width: Math.max(320, Math.floor(viewportSize.width - 24)),
      height: Math.max(240, Math.floor(viewportSize.height - 136)),
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

  const minimapSize = useMemo(() => {
    if (!fittedImageSize) return null;
    const scale = Math.min(148 / fittedImageSize.width, 108 / fittedImageSize.height);
    return {
      width: Math.max(1, Math.round(fittedImageSize.width * scale)),
      height: Math.max(1, Math.round(fittedImageSize.height * scale)),
    };
  }, [fittedImageSize]);

  const viewportSizeRef = useRef(imageViewportSize);
  const fitSizeRef = useRef(fittedImageSize);
  const minimapSizeRef = useRef(minimapSize);
  useLayoutEffect(() => {
    viewportSizeRef.current = imageViewportSize;
    fitSizeRef.current = fittedImageSize;
    minimapSizeRef.current = minimapSize;
  }, [fittedImageSize, imageViewportSize, minimapSize]);

  const applyCameraToDom = useCallback(() => {
    const frame = imageFrameRef.current;
    const fit = fitSizeRef.current;
    const vp = viewportSizeRef.current;
    if (!frame || !fit) return;

    const cam = clampQuickLookCamera(cameraRef.current, vp, fit);
    cameraRef.current = cam;
    frame.style.transform = `translate3d(${cam.tx.toFixed(2)}px, ${cam.ty.toFixed(2)}px, 0) scale(${cam.scale.toFixed(5)})`;

    const miniBox = minimapWindowRef.current;
    const miniSize = minimapSizeRef.current;
    if (miniBox && miniSize) {
      const rect = getMinimapViewportRect(cam, vp, fit, miniSize);
      miniBox.style.transform = `translate3d(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px, 0)`;
      miniBox.style.width = `${rect.width.toFixed(1)}px`;
      miniBox.style.height = `${rect.height.toFixed(1)}px`;
    }
  }, []);

  const syncZoomUiThresholds = useCallback((scale: number) => {
    const nextZoomed = scale > 1.005;
    const nextMinimap = scale >= 1.5;
    setIsZoomed((current) => (current === nextZoomed ? current : nextZoomed));
    setShowMinimap((current) => (current === nextMinimap ? current : nextMinimap));
  }, []);

  const scheduleCommitZoom = useCallback(
    (scale: number) => {
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
      }
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null;
        onCommittedZoomChange(scale);
      }, 140);
    },
    [onCommittedZoomChange]
  );

  const scheduleCameraRender = useCallback(
    (nextCamera: QuickLookCamera, commit = false) => {
      cameraRef.current = nextCamera;
      onZoomDisplayChange(nextCamera.scale);
      syncZoomUiThresholds(nextCamera.scale);
      if (commit) {
        scheduleCommitZoom(nextCamera.scale);
      }
      if (renderRafRef.current !== null) return;
      renderRafRef.current = window.requestAnimationFrame(() => {
        renderRafRef.current = null;
        applyCameraToDom();
      });
    },
    [applyCameraToDom, onZoomDisplayChange, scheduleCommitZoom, syncZoomUiThresholds]
  );

  const cancelCameraAnimation = useCallback(() => {
    if (animRafRef.current !== null) {
      window.cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }
  }, []);

  const animateCameraTo = useCallback(
    (target: QuickLookCamera, durationMs = 170) => {
      cancelCameraAnimation();
      const start = { ...cameraRef.current };
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        const current: QuickLookCamera = {
          scale: start.scale + (target.scale - start.scale) * eased,
          tx: start.tx + (target.tx - start.tx) * eased,
          ty: start.ty + (target.ty - start.ty) * eased,
        };
        cameraRef.current = current;
        applyCameraToDom();
        onZoomDisplayChange(current.scale);
        syncZoomUiThresholds(current.scale);
        if (t < 1) {
          animRafRef.current = window.requestAnimationFrame(step);
        } else {
          animRafRef.current = null;
          onCommittedZoomChange(target.scale);
        }
      };
      animRafRef.current = window.requestAnimationFrame(step);
    },
    [
      applyCameraToDom,
      cancelCameraAnimation,
      onCommittedZoomChange,
      onZoomDisplayChange,
      syncZoomUiThresholds,
    ]
  );

  const registerZoomFrame = useCallback(
    (node: HTMLDivElement | null) => {
      imageFrameRef.current = node;
      if (node) {
        applyCameraToDom();
      }
    },
    [applyCameraToDom]
  );

  // Re-clamp & paint whenever viewport, fitted image size, or minimap visibility updates.
  useLayoutEffect(() => {
    if (!fittedImageSize) return;
    cameraRef.current = clampQuickLookCamera(cameraRef.current, imageViewportSize, fittedImageSize);
    applyCameraToDom();
  }, [applyCameraToDom, fittedImageSize, imageViewportSize, showMinimap]);

  useEffect(() => {
    const viewport = imageViewportRef.current;
    if (!viewport) return;

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

  // Native non-passive trackpad pinch (Safari/WKWebView gesture* + wheel ctrlKey)
  // and native two-finger trackpad pan when zoomed in.
  useEffect(() => {
    const viewport = imageViewportRef.current;
    if (!viewport) return;

    const onGestureStart = (event: Event) => {
      const gesture = event as SafariGestureEvent;
      gesture.preventDefault();
      cancelCameraAnimation();
      nativeGestureActiveRef.current = true;
      nativeGestureBaseScaleRef.current = cameraRef.current.scale;
    };

    const onGestureChange = (event: Event) => {
      const gesture = event as SafariGestureEvent;
      gesture.preventDefault();
      const fit = fitSizeRef.current;
      if (!fit) return;
      const rect = viewport.getBoundingClientRect();
      const anchorX = Number.isFinite(gesture.clientX)
        ? gesture.clientX - rect.left
        : rect.width / 2;
      const anchorY = Number.isFinite(gesture.clientY)
        ? gesture.clientY - rect.top
        : rect.height / 2;
      const targetScale = nativeGestureBaseScaleRef.current * gesture.scale;
      const next = zoomCameraAtPoint(
        cameraRef.current,
        targetScale,
        anchorX,
        anchorY,
        viewportSizeRef.current,
        fit
      );
      scheduleCameraRender(next, false);
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      nativeGestureActiveRef.current = false;
      scheduleCommitZoom(cameraRef.current.scale);
    };

    const onWheel = (event: globalThis.WheelEvent) => {
      const fit = fitSizeRef.current;
      if (!fit) return;

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (nativeGestureActiveRef.current) {
          // Avoid double-zooming when macOS WebKit fires both gesturechange and ctrl+wheel.
          return;
        }
        cancelCameraAnimation();
        const rect = viewport.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorY = event.clientY - rect.top;
        const sensitivity = event.ctrlKey ? 0.012 : 0.0045;
        const clampedDelta = Math.max(-120, Math.min(120, event.deltaY));
        const targetScale = cameraRef.current.scale * Math.exp(-clampedDelta * sensitivity);
        const next = zoomCameraAtPoint(
          cameraRef.current,
          targetScale,
          anchorX,
          anchorY,
          viewportSizeRef.current,
          fit
        );
        scheduleCameraRender(next, true);
        return;
      }

      // Two-finger trackpad panning when zoomed in.
      if (cameraRef.current.scale > 1.005) {
        event.preventDefault();
        cancelCameraAnimation();
        const next = panCameraBy(
          cameraRef.current,
          -event.deltaX,
          -event.deltaY,
          viewportSizeRef.current,
          fit
        );
        scheduleCameraRender(next, false);
      }
    };

    viewport.addEventListener("gesturestart", onGestureStart, { passive: false });
    viewport.addEventListener("gesturechange", onGestureChange, { passive: false });
    viewport.addEventListener("gestureend", onGestureEnd, { passive: false });
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
      viewport.removeEventListener("gestureend", onGestureEnd);
      viewport.removeEventListener("wheel", onWheel);
    };
  }, [cancelCameraAnimation, scheduleCameraRender, scheduleCommitZoom]);

  const canPan = isZoomed && !sharpnessInspector.selectionMode;

  const handlePanStart = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canPan || event.button !== 0) return;
      const viewport = imageViewportRef.current;
      if (!viewport) return;
      cancelCameraAnimation();
      panStartRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        tx: cameraRef.current.tx,
        ty: cameraRef.current.ty,
      };
      viewport.setPointerCapture(event.pointerId);
    },
    [canPan, cancelCameraAnimation]
  );

  const handlePanMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = panStartRef.current;
      const fit = fitSizeRef.current;
      if (!start || !fit || start.pointerId !== event.pointerId) return;
      const next = clampQuickLookCamera(
        {
          scale: cameraRef.current.scale,
          tx: start.tx + (event.clientX - start.x),
          ty: start.ty + (event.clientY - start.y),
        },
        viewportSizeRef.current,
        fit
      );
      scheduleCameraRender(next, false);
    },
    [scheduleCameraRender]
  );

  const handlePanEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const viewport = imageViewportRef.current;
    if (panStartRef.current?.pointerId !== event.pointerId) return;
    panStartRef.current = null;
    if (viewport?.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (sharpnessInspector.selectionMode) return;
      const viewport = imageViewportRef.current;
      const fit = fitSizeRef.current;
      if (!viewport || !fit) return;

      if (cameraRef.current.scale > 1.05) {
        const fitCam = clampQuickLookCamera(
          { scale: 1, tx: 0, ty: 0 },
          viewportSizeRef.current,
          fit
        );
        animateCameraTo(fitCam);
        return;
      }

      const rect = viewport.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const naturalScale = imageDimensions ? imageDimensions.width / Math.max(1, fit.width) : 2.5;
      const targetScale = clampQuickLookZoom(Math.max(2.2, Math.min(3.5, naturalScale)));
      const target = zoomCameraAtPoint(
        cameraRef.current,
        targetScale,
        anchorX,
        anchorY,
        viewportSizeRef.current,
        fit
      );
      animateCameraTo(target);
    },
    [animateCameraTo, imageDimensions, sharpnessInspector.selectionMode]
  );

  const moveMinimapViewport = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const fit = fitSizeRef.current;
      if (!fit) return;
      cancelCameraAnimation();
      const rect = event.currentTarget.getBoundingClientRect();
      const normX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const normY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      const next = centerCameraOnNormalizedPoint(
        cameraRef.current.scale,
        normX,
        normY,
        viewportSizeRef.current,
        fit
      );
      scheduleCameraRender(next, false);
    },
    [cancelCameraAnimation, scheduleCameraRender]
  );

  useEffect(() => {
    if (!zoomActionsRef) return;
    zoomActionsRef.current = {
      toggleOneToOne: () => {
        const fit = fitSizeRef.current;
        if (!fit) return;
        if (cameraRef.current.scale > 1.05) {
          animateCameraTo(
            clampQuickLookCamera({ scale: 1, tx: 0, ty: 0 }, viewportSizeRef.current, fit)
          );
          return;
        }
        const naturalScale = imageDimensions ? imageDimensions.width / Math.max(1, fit.width) : 2.5;
        const targetZoom = clampQuickLookZoom(Math.max(2.2, Math.min(4, naturalScale)));
        animateCameraTo(
          centerCameraOnNormalizedPoint(targetZoom, 0.5, 0.5, viewportSizeRef.current, fit)
        );
      },
      zoomToNormalizedPoint: (normX: number, normY: number, targetZoom?: number) => {
        const fit = fitSizeRef.current;
        if (!fit) return;
        const naturalScale = imageDimensions ? imageDimensions.width / Math.max(1, fit.width) : 3;
        const resolvedZoom = clampQuickLookZoom(
          targetZoom ?? Math.max(2.5, Math.min(4.5, naturalScale))
        );
        animateCameraTo(
          centerCameraOnNormalizedPoint(resolvedZoom, normX, normY, viewportSizeRef.current, fit)
        );
      },
    };
    return () => {
      zoomActionsRef.current = null;
    };
  }, [animateCameraTo, imageDimensions, zoomActionsRef]);

  useEffect(() => {
    return () => {
      if (renderRafRef.current !== null) window.cancelAnimationFrame(renderRafRef.current);
      if (animRafRef.current !== null) window.cancelAnimationFrame(animRafRef.current);
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
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
        className={`relative flex h-full w-full items-center justify-center overflow-hidden select-none ${
          canPan ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
        }`}
        style={{
          contain: "layout paint size",
          isolation: "isolate",
          overscrollBehavior: "none",
          touchAction: "none",
        }}
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerCancel={handlePanEnd}
        onDoubleClick={handleDoubleClick}
      >
        {useNativeImagePreview || !isBrowserSupportedImage(entry.extension) ? (
          nativePreviewSrc ? (
            <ZoomableImageElement
              entry={entry}
              src={nativePreviewSrc}
              clippingMaskUrl={clippingMaskUrl}
              detectedFaces={detectedFaces}
              activeFaceIndex={activeFaceIndex}
              renderedImageSize={fittedImageSize}
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
              className="quick-look-image-frame shrink-0"
              style={
                fittedImageSize
                  ? {
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: `${fittedImageSize.width}px`,
                      height: `${fittedImageSize.height}px`,
                      transformOrigin: "0 0",
                      willChange: "transform",
                    }
                  : { position: "relative", maxWidth: "100%", maxHeight: "100%" }
              }
            >
              <FileThumbnail
                entry={entry}
                size={320}
                requestSizeOverride={
                  RAW_EXTENSIONS.has((entry.extension ?? "").toLowerCase())
                    ? 512
                    : progressivePreviewRequestSize
                }
                className={`${fittedImageSize ? "h-full w-full" : "h-auto max-h-full w-auto max-w-full"} rounded-md object-contain`}
                fallbackClassName="text-muted-foreground h-40 w-40"
                onImageLoad={handleDisplayedImageLoad}
              />
              {clippingMaskUrl ? (
                <img
                  src={clippingMaskUrl}
                  alt=""
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full rounded-md object-contain select-none"
                  draggable={false}
                />
              ) : null}
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
              {sharpnessOverlay}
            </div>
          )
        ) : (
          <ZoomableImageElement
            entry={entry}
            src={fallbackSrc || fileSrc || ""}
            clippingMaskUrl={clippingMaskUrl}
            detectedFaces={detectedFaces}
            activeFaceIndex={activeFaceIndex}
            renderedImageSize={fittedImageSize}
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
      {showMinimap && minimapSize && fittedImageSize && (
        <div className="bg-background/85 absolute right-3 bottom-3 z-20 rounded-lg border border-white/20 p-1.5 shadow-xl backdrop-blur-md">
          <div
            className="relative cursor-crosshair overflow-hidden rounded-sm"
            style={{ width: minimapSize.width, height: minimapSize.height, touchAction: "none" }}
            role="button"
            tabIndex={0}
            aria-label={t("common.quick_look.minimap")}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              moveMinimapViewport(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                moveMinimapViewport(event);
              }
            }}
            onKeyDown={(event) => {
              const fit = fitSizeRef.current;
              if (!fit) return;
              const step = 80;
              let dx = 0;
              let dy = 0;
              if (event.key === "ArrowLeft") dx = step;
              else if (event.key === "ArrowRight") dx = -step;
              else if (event.key === "ArrowUp") dy = step;
              else if (event.key === "ArrowDown") dy = -step;
              else return;
              event.preventDefault();
              event.stopPropagation();
              scheduleCameraRender(
                panCameraBy(cameraRef.current, dx, dy, viewportSizeRef.current, fit),
                false
              );
            }}
          >
            <img
              src={minimapSrc || nativePreviewSrc || fallbackSrc || fileSrc || ""}
              alt=""
              className="h-full w-full object-fill select-none"
              draggable={false}
            />
            <div
              ref={minimapWindowRef}
              className="pointer-events-none absolute top-0 left-0 rounded-sm border-2 border-white bg-white/10 shadow-sm"
            />
          </div>
        </div>
      )}
    </div>
  );
});

export function QuickLook({
  entry,
  entries,
  entryAnalysis,
  photoAnalysis,
  cullingState,
  autoAdvance = false,
  onClose,
  onNavigate,
  onToggleTag,
  onSetRating,
  onSetFlag,
  onDelete,
  onExtract,
}: QuickLookProps) {
  const { t } = useTranslation();
  const activeCulling = cullingState ?? DEFAULT_CULLING_STATE;
  const [showClippingOverlay, setShowClippingOverlay] = useState(false);
  const [faceDetection, setFaceDetection] = useState<{
    path: string;
    faces: DetectedFace[];
    activeIndex: number;
  } | null>(null);
  const [detectingFaces, setDetectingFaces] = useState(false);
  const [histogramRecord, setHistogramRecord] = useState<{
    path: string;
    histogram: PhotoHistogramData;
    clippingMaskUrl: string | null;
  } | null>(null);
  const zoomActionsRef = useRef<ZoomPreviewActions | null>(null);
  const isOpen = Boolean(entry);
  const entryPath = entry?.path ?? null;
  const entryModified = entry?.modified ?? 0;
  const entrySize = entry?.size ?? 0;
  const entryExtension = entry?.extension ?? "";
  const entryIdentity = entry ? `${entryPath}\u0000${entryModified}\u0000${entrySize}` : null;

  const [textContent, setTextContent] = useState<string | null>(null);
  const [zipPreviewRecord, setZipPreviewRecord] = useState<{
    path: string;
    preview: ZipArchivePreview;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [useNativeImagePreview, setUseNativeImagePreview] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<ImageDimensions | null>(null);
  const [nativePreviewSrc, setNativePreviewSrc] = useState<string | null>(null);
  const [interactionPreviewSrc, setInteractionPreviewSrc] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  const [committedZoom, setCommittedZoom] = useState(1);
  const zoomSourceTimerRef = useRef<number | null>(null);
  const [customDialogSize, setCustomDialogSize] = useState<ImageDimensions | null>(null);
  const embeddedArwJpegLoadedRef = useRef(false);
  const embeddedArwJpegAttemptedRef = useRef(false);
  const embeddedArwJpegLoadingRef = useRef(false);
  const activeEntryIdentityRef = useRef(entryIdentity);
  activeEntryIdentityRef.current = entryIdentity;
  const resizeStartRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
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
    if ((entry.extension || "").toLowerCase() === "zip") return "zip";
    if (isTextFile(entry.extension) && entry.size < 1024 * 1024) return "text";
    return "icon";
  }, [entry]);
  const cameraAfMetadata = useCameraAfMetadata(entry, previewType === "image", "interactive");
  const photoMetadata = usePhotoMetadata(entry, previewType === "image");

  const dialogSizeClass = useMemo(() => {
    if (!entry) {
      return "h-[min(88vh,48rem)] w-[min(92vw,72rem)]";
    }

    switch (previewType) {
      case "image":
        return "max-h-[calc(100vh-2.75rem)] max-w-[calc(100vw-1rem)]";
      case "pdf":
      case "video":
        return "h-[min(92vh,64rem)] w-[min(96vw,96rem)]";
      case "text":
      case "zip":
        return "h-[min(88vh,56rem)] w-[min(92vw,80rem)]";
      default:
        return "h-[min(82vh,42rem)] w-[min(88vw,56rem)]";
    }
  }, [entry, previewType]);

  const contentPaddingClass =
    previewType === "image"
      ? "p-1"
      : previewType === "pdf" || previewType === "video"
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
    if (!entry || previewType !== "image" || currentEntryIndex < 0) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      preloadNeighborEntries(quickLookEntries, currentEntryIndex, "quicklook", controller.signal);
    }, 140);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [currentEntryIndex, entry, previewType, quickLookEntries]);

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

    const cached = getLargestLoadedFileThumbnailUrl(entryPath, entryModified, entrySize);
    return cached ? { size: cached.requestSize, src: cached.url } : null;
  }, [entryModified, entryPath, entrySize]);

  const dialogStyle = useMemo<CSSProperties | undefined>(() => {
    if (previewType !== "image") {
      return undefined;
    }
    const maxDialogWidth = Math.max(360, viewportSize.width - 16);
    const maxDialogHeight = Math.max(280, viewportSize.height - 44);
    return {
      width: `${Math.min(customDialogSize?.width ?? maxDialogWidth, maxDialogWidth)}px`,
      height: `${Math.min(customDialogSize?.height ?? maxDialogHeight, maxDialogHeight)}px`,
    };
  }, [customDialogSize, previewType, viewportSize.height, viewportSize.width]);

  const scheduleZoomSourceUpgrade = useCallback((zoom: number) => {
    if (embeddedArwJpegLoadedRef.current) return;
    if (zoomSourceTimerRef.current !== null) window.clearTimeout(zoomSourceTimerRef.current);
    zoomSourceTimerRef.current = window.setTimeout(() => {
      zoomSourceTimerRef.current = null;
      setCommittedZoom(zoom);
    }, 420);
  }, []);

  const finishDialogResize = useCallback((pointerId: number) => {
    const start = resizeStartRef.current;
    if (!start || start.pointerId !== pointerId) return;
    resizeStartRef.current = null;
    const dialog = dialogRef.current;
    if (dialog) setCustomDialogSize({ width: dialog.offsetWidth, height: dialog.offsetHeight });
  }, []);

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
    setInteractionPreviewSrc(null);
    embeddedArwJpegLoadedRef.current = false;
    embeddedArwJpegAttemptedRef.current = false;
    embeddedArwJpegLoadingRef.current = false;
    if (zoomSourceTimerRef.current !== null) {
      window.clearTimeout(zoomSourceTimerRef.current);
      zoomSourceTimerRef.current = null;
    }
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

  const handleEyeFocusZoom = useCallback(async () => {
    if (!entryPath || previewType !== "image" || detectingFaces) return;
    if (faceDetection && faceDetection.path === entryPath) {
      if (faceDetection.faces.length === 0) return;
      const nextIndex = faceDetection.activeIndex + 1;
      if (nextIndex < faceDetection.faces.length) {
        const face = faceDetection.faces[nextIndex];
        setFaceDetection({ ...faceDetection, activeIndex: nextIndex });
        zoomActionsRef.current?.zoomToNormalizedPoint(face.eyeX, face.eyeY);
      } else {
        setFaceDetection({ ...faceDetection, activeIndex: -1 });
        zoomActionsRef.current?.toggleOneToOne();
      }
      return;
    }

    setDetectingFaces(true);
    try {
      const faces = await invoke<DetectedFace[]>("detect_photo_faces", { path: entryPath });
      if (activeEntryIdentityRef.current !== entryIdentity) return;
      if (faces.length > 0) {
        setFaceDetection({ path: entryPath, faces, activeIndex: 0 });
        zoomActionsRef.current?.zoomToNormalizedPoint(faces[0].eyeX, faces[0].eyeY);
      } else {
        setFaceDetection({ path: entryPath, faces: [], activeIndex: -1 });
      }
    } catch (err) {
      console.error("Failed to detect faces:", err);
      if (activeEntryIdentityRef.current === entryIdentity) {
        setFaceDetection({ path: entryPath, faces: [], activeIndex: -1 });
      }
    } finally {
      setDetectingFaces(false);
    }
  }, [detectingFaces, entryIdentity, entryPath, faceDetection, previewType]);

  // ESC 关闭 + 媒体清理
  useEffect(() => {
    if (!entry) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        shouldIgnoreKeyboardCommand(e, {
          allowOverlaySelector: '[data-keyboard-scope="quick-look"]',
        })
      ) {
        return;
      }

      const eventTarget = e.target instanceof Element ? e.target : null;
      const activeElement =
        document.activeElement instanceof Element ? document.activeElement : null;
      const isSliderOrListbox = [eventTarget, activeElement].some((element) =>
        Boolean(element?.closest('[role="slider"], input[type="range"], [role="listbox"]'))
      );

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
        e.stopPropagation();
        onClose();
        return;
      }

      // Close Quick Look on Space (macOS Finder parity) unless a button/link has focus.
      if (
        e.code === "Space" &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !isInteractiveKeyboardTarget(eventTarget) &&
        !isInteractiveKeyboardTarget(activeElement)
      ) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (
        !isSliderOrListbox &&
        canNavigate &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          if (previousEntry) onNavigate(previousEntry);
          return;
        }
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          if (nextEntry) onNavigate(nextEntry);
          return;
        }
      }

      if (
        previewType === "image" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "z" || e.key === "Z")
      ) {
        e.preventDefault();
        zoomActionsRef.current?.toggleOneToOne();
        return;
      }

      if (
        previewType === "image" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        void handleEyeFocusZoom();
        return;
      }

      // Photography culling shortcuts inside QuickLook:
      // 1-7 toggle Finder color tags; P/X/U flag; Shift+0..5 star; Cmd+Backspace deletes and advances.
      if (
        onToggleTag &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        /^[1-7]$/.test(e.key)
      ) {
        const preset = FINDER_TAG_PRESETS[Number(e.key) - 1];
        if (preset) {
          e.preventDefault();
          onToggleTag(entry, preset.id);
          if (autoAdvance && nextEntry) onNavigate(nextEntry);
          return;
        }
      }

      if (
        onSetFlag &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "p" ||
          e.key === "P" ||
          e.key === "x" ||
          e.key === "X" ||
          e.key === "u" ||
          e.key === "U")
      ) {
        e.preventDefault();
        const lower = e.key.toLowerCase();
        if (lower === "p") {
          onSetFlag(entry, activeCulling.flag === "pick" ? "none" : "pick");
        } else if (lower === "x") {
          onSetFlag(entry, activeCulling.flag === "reject" ? "none" : "reject");
        } else {
          onSetFlag(entry, "none");
        }
        if (autoAdvance && nextEntry) onNavigate(nextEntry);
        return;
      }

      if (
        onSetRating &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        /^Digit[0-5]$/.test(e.code)
      ) {
        e.preventDefault();
        const star = Number(e.code.slice(5));
        onSetRating(entry, star === activeCulling.rating ? 0 : star);
        if (autoAdvance && nextEntry) onNavigate(nextEntry);
        return;
      }

      if (
        onDelete &&
        !entry.readonly &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key === "Backspace"
      ) {
        e.preventDefault();
        const fallbackNext = nextEntry ?? previousEntry ?? null;
        void onDelete(entry).then(() => {
          if (fallbackNext) onNavigate(fallbackNext);
          else onClose();
        });
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
  }, [
    activeCulling.flag,
    activeCulling.rating,
    autoAdvance,
    canNavigate,
    entry,
    handleEyeFocusZoom,
    nextEntry,
    onClose,
    onDelete,
    onNavigate,
    onSetFlag,
    onSetRating,
    onToggleTag,
    previewType,
    previousEntry,
  ]);

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
    // Camera RAW files embed a full-resolution JPEG preview. Extract and
    // display it directly via `thumb://localhost/raw` instead of demosaicing twice.
    const preferEmbeddedPreview = RAW_EXTENSIONS.has(entryExtension.toLowerCase());

    const applyPreviewSource = (src: string, requestSize: number) => {
      if (cancelled || requestSize < nativePreviewSizeRef.current) return;
      nativePreviewSizeRef.current = requestSize;
      setNativePreviewSrc((current) => (current === src ? current : src));
    };

    if (cachedNativePreview?.src) {
      applyPreviewSource(cachedNativePreview.src, cachedNativePreview.size);
    }

    const loadPreview = (requestSize: number) => {
      const availableSize = Math.max(
        nativePreviewSizeRef.current,
        nativePreviewTargetSizeRef.current
      );
      if (!shouldUpgradeNativePreview(availableSize, requestSize)) {
        return Promise.resolve();
      }

      nativePreviewTargetSizeRef.current = requestSize;
      const url = buildFileThumbnailUrl(
        entryPath,
        entryModified,
        entrySize,
        requestSize,
        preferEmbeddedPreview,
        !preferEmbeddedPreview
      );
      return loadHtmlImage(url, controller.signal)
        .then(() => {
          applyPreviewSource(url, requestSize);
        })
        .catch(() => undefined)
        .finally(() => {
          if (nativePreviewTargetSizeRef.current === requestSize) {
            nativePreviewTargetSizeRef.current = nativePreviewSizeRef.current;
          }
        });
    };

    const loadFullPreview = () => loadPreview(nativePreviewRequestSize);
    if (preferEmbeddedPreview) {
      if (embeddedArwJpegLoadedRef.current) return () => controller.abort();
      if (embeddedArwJpegLoadingRef.current) return () => controller.abort();
      if (!embeddedArwJpegAttemptedRef.current) {
        embeddedArwJpegAttemptedRef.current = true;
        embeddedArwJpegLoadingRef.current = true;
        const requestedEntryIdentity = entryIdentity;
        const interactiveUrl = buildRawEmbeddedJpegUrl(
          entryPath,
          entryModified,
          entrySize,
          ARW_INTERACTIVE_PREVIEW_SIZE
        );
        const gestureUrl = buildRawEmbeddedJpegUrl(
          entryPath,
          entryModified,
          entrySize,
          ARW_GESTURE_PREVIEW_SIZE
        );
        void loadHtmlImage(interactiveUrl)
          .then(() => {
            if (activeEntryIdentityRef.current !== requestedEntryIdentity) return;
            embeddedArwJpegLoadingRef.current = false;
            embeddedArwJpegLoadedRef.current = true;
            applyPreviewSource(interactiveUrl, ARW_INTERACTIVE_PREVIEW_SIZE);
            void loadHtmlImage(gestureUrl)
              .then(() => {
                if (activeEntryIdentityRef.current === requestedEntryIdentity) {
                  setInteractionPreviewSrc(gestureUrl);
                }
              })
              .catch(() => {});
          })
          .catch(() => {
            if (activeEntryIdentityRef.current !== requestedEntryIdentity) return;
            embeddedArwJpegLoadingRef.current = false;
            void loadFullPreview();
          });
        return () => {};
      }
    }
    const availableSize = Math.max(
      nativePreviewSizeRef.current,
      nativePreviewTargetSizeRef.current
    );

    // Decode at most one useful upgrade at a time. Small zoom and resize
    // changes reuse the current frame; a new native decode starts only after
    // a meaningful resolution step.
    if (
      !preferEmbeddedPreview &&
      shouldUpgradeNativePreview(availableSize, progressivePreviewRequestSize)
    ) {
      void loadPreview(progressivePreviewRequestSize).finally(() => {
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
    isRawImage,
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

  useEffect(() => {
    if (!entryPath || previewType !== "zip") {
      return;
    }
    let cancelled = false;
    const loadZip = async () => {
      try {
        setLoading(true);
        setError(null);
        const preview = await invoke<ZipArchivePreview>("list_zip_entries", { path: entryPath });
        if (!cancelled) {
          setZipPreviewRecord({ path: entryPath, preview });
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadZip();
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

    // Fall back directly to the binary `thumb://` protocol (works for external
    // volumes outside asset scope without encoding the image as Base64).
    setUseNativeImagePreview(true);
    setError(null);
  }, [entryPath]);

  // Compute compact RGB histogram (and optional blown-highlight/crushed-shadow clipping mask)
  // from the thumbnail URL asynchronously without blocking QuickLook zoom/pan interactions.
  useEffect(() => {
    if (!entryPath || previewType !== "image") return;
    const controller = new AbortController();
    const url = buildFileThumbnailUrl(
      entryPath,
      entryModified,
      entrySize,
      showClippingOverlay ? 512 : 384,
      true,
      false
    );
    void loadHtmlImage(url, controller.signal)
      .then((img) => {
        if (controller.signal.aborted) return;
        const extracted = extractHistogramFromImageElement(
          img,
          showClippingOverlay ? 384 : 256,
          showClippingOverlay
        );
        if (extracted) {
          setHistogramRecord({
            path: entryPath,
            histogram: extracted.histogram,
            clippingMaskUrl: extracted.clippingMaskUrl,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [entryModified, entryPath, entrySize, previewType, showClippingOverlay]);

  if (!entry) return null;

  const activeHistogram = histogramRecord?.path === entryPath ? histogramRecord.histogram : null;
  const activeClippingMaskUrl =
    showClippingOverlay && histogramRecord?.path === entryPath
      ? histogramRecord.clippingMaskUrl
      : null;

  const activeFaceDetection = faceDetection?.path === entryPath ? faceDetection : null;
  const activeDetectedFaces = activeFaceDetection?.faces ?? [];
  const activeFaceIndex = activeFaceDetection?.activeIndex ?? -1;

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
                interactionPreviewSrc={interactionPreviewSrc}
                minimapSrc={cachedNativePreview?.src ?? null}
                fallbackSrc={fallbackSrc}
                fileSrc={fileSrc}
                clippingMaskUrl={activeClippingMaskUrl}
                detectedFaces={activeDetectedFaces}
                activeFaceIndex={activeFaceIndex}
                zoomActionsRef={zoomActionsRef}
                useNativeImagePreview={useNativeImagePreview}
                progressivePreviewRequestSize={progressivePreviewRequestSize}
                sharpnessAutoReady={
                  !RAW_EXTENSIONS.has(entryExtension.toLowerCase()) ||
                  nativePreviewSizeRef.current >= nativePreviewRequestSize
                }
                onImageLoadDimensions={handleImageLoadDimensions}
                onBrowserImageError={handleBrowserImageError}
                onZoomDisplayChange={updateZoomIndicator}
                onCommittedZoomChange={scheduleZoomSourceUpgrade}
                focusAnalysis={
                  (entryAnalysis ?? photoAnalysis?.get(entry.path))?.focusAnalysis ?? null
                }
                cameraAfMetadata={cameraAfMetadata}
              />
            </div>
            <QuickLookPhotoFooter
              metadata={photoMetadata}
              analysis={entryAnalysis ?? photoAnalysis?.get(entry.path)}
              cameraAfMetadata={cameraAfMetadata}
              histogram={activeHistogram}
              showClippingOverlay={showClippingOverlay}
              onToggleClippingOverlay={() => setShowClippingOverlay((v) => !v)}
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

      case "zip": {
        const zip = zipPreviewRecord?.path === entryPath ? zipPreviewRecord.preview : null;
        if (!zip) return null;
        const ratio =
          zip.totalUncompressed > 0
            ? Math.max(0, Math.round((1 - zip.totalCompressed / zip.totalUncompressed) * 100))
            : 0;
        return (
          <div className="flex h-full w-full flex-col gap-3 overflow-hidden">
            <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Archive className="text-primary h-4 w-4" aria-hidden="true" />
                  {t("common.quick_look.zip_summary", {
                    count: zip.totalEntries,
                    uncompressed: formatFileSize(zip.totalUncompressed),
                    compressed: formatFileSize(zip.totalCompressed),
                    ratio,
                  })}
                </span>
                {zip.truncated && (
                  <span className="text-muted-foreground">
                    {t("common.quick_look.zip_truncated", { shown: zip.entries.length })}
                  </span>
                )}
              </div>
              {onExtract && (
                <button
                  type="button"
                  onClick={() => {
                    onExtract(entry);
                    onClose();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium"
                >
                  <PackageOpen className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("context_menu.extract_zip")}
                </button>
              )}
            </div>
            <div className="bg-muted/20 min-h-0 flex-1 overflow-y-auto rounded-lg border">
              <div className="divide-border/50 divide-y text-xs">
                {zip.entries.map((item) => (
                  <div
                    key={item.name}
                    className="hover:bg-accent/50 flex items-center justify-between gap-3 px-3 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {item.isDir ? (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden="true" />
                      ) : (
                        <File
                          className="text-muted-foreground h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate font-mono">{item.name}</span>
                    </div>
                    <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                      {item.isDir ? "--" : formatFileSize(item.uncompressedSize)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      }

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-2 pt-9 pb-2"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className={`bg-background text-foreground relative flex ${dialogSizeClass} flex-col overflow-hidden rounded-lg border border-black/8 shadow-xl`}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        data-keyboard-scope="quick-look"
        aria-label={t("common.quick_look.preview")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title Bar */}
        <div className="bg-muted/25 relative flex h-10 shrink-0 items-center justify-between border-b border-black/6 px-2.5">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.quick_look.close")}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:outline-none dark:hover:bg-white/10"
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
                  className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 focus-visible:ring-ring flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:outline-none disabled:hover:bg-transparent dark:hover:bg-white/10"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => nextEntry && onNavigate(nextEntry)}
                  disabled={!nextEntry}
                  aria-label={t("common.quick_look.next")}
                  className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 focus-visible:ring-ring flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:ring-2 focus-visible:outline-none disabled:hover:bg-transparent dark:hover:bg-white/10"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
          <div className="pointer-events-none absolute left-1/2 flex max-w-[44%] min-w-0 -translate-x-1/2 items-center gap-2 text-xs font-medium">
            <span className="truncate" title={entry.name}>
              {entry.name}
            </span>
            <span className="text-muted-foreground shrink-0 font-normal tabular-nums">
              {t("common.quick_look.preview")}
              <span ref={zoomIndicatorRef}>{previewType === "image" ? " 100%" : ""}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {previewType === "image" && (
              <button
                type="button"
                onClick={() => void handleEyeFocusZoom()}
                disabled={detectingFaces}
                aria-pressed={activeFaceIndex >= 0}
                title={t("common.quick_look.eye_focus")}
                className={`hidden items-center gap-1 rounded px-2 py-1 text-xs transition-colors sm:inline-flex ${
                  activeFaceIndex >= 0
                    ? "bg-emerald-500/20 font-medium text-emerald-700 dark:text-emerald-300"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {detectingFaces ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ScanFace className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>
                  {detectingFaces
                    ? t("common.quick_look.eye_focus_scanning")
                    : activeFaceDetection && activeDetectedFaces.length === 0
                      ? t("common.quick_look.eye_focus_none")
                      : activeFaceIndex >= 0
                        ? t("common.quick_look.eye_focus_cycle", {
                            current: activeFaceIndex + 1,
                            total: activeDetectedFaces.length,
                          })
                        : t("common.quick_look.eye_focus")}
                </span>
              </button>
            )}
            {previewType === "image" && onSetFlag && (
              <div className="hidden items-center gap-1 sm:flex">
                <button
                  type="button"
                  aria-pressed={activeCulling.flag === "pick"}
                  title={`${t("file_list.culling.pick")} (P)`}
                  onClick={() => onSetFlag(entry, activeCulling.flag === "pick" ? "none" : "pick")}
                  className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs transition-colors ${
                    activeCulling.flag === "pick"
                      ? "bg-emerald-500/20 font-medium text-emerald-700 dark:text-emerald-300"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-pressed={activeCulling.flag === "reject"}
                  title={`${t("file_list.culling.reject")} (X)`}
                  onClick={() =>
                    onSetFlag(entry, activeCulling.flag === "reject" ? "none" : "reject")
                  }
                  className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs transition-colors ${
                    activeCulling.flag === "reject"
                      ? "bg-destructive/20 text-destructive font-medium"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
            {previewType === "image" && onSetRating && (
              <div
                className="hidden items-center gap-0.5 md:flex"
                title="⇧0–⇧5"
                role="group"
                aria-label={t("file_list.culling.rating_any")}
              >
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => onSetRating(entry, activeCulling.rating === star ? 0 : star)}
                    aria-label={`${star}★`}
                    className="text-muted-foreground p-0.5 transition-colors hover:text-amber-500"
                  >
                    <Star
                      className={`h-3.5 w-3.5 ${
                        star <= activeCulling.rating ? "fill-amber-400 text-amber-400" : ""
                      }`}
                    />
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={handleOpen}
              className="text-primary hover:text-primary/80 focus-visible:ring-ring flex h-8 items-center gap-1 rounded-md px-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              {t("common.quick_look.open")}
            </button>
          </div>
        </div>

        {/* Content */}
        <div
          className={`flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-hidden ${contentPaddingClass}`}
        >
          {renderPreview()}
        </div>
        {previewType === "image" ? (
          <button
            type="button"
            aria-label={t("common.quick_look.resize")}
            title={t("common.quick_look.resize")}
            className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-primary absolute right-0 bottom-0 z-40 flex h-5 w-5 cursor-nwse-resize items-end justify-end rounded-tl p-1 focus-visible:ring-2"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              if (event.button !== 0 || !dialogRef.current) return;
              event.preventDefault();
              event.stopPropagation();
              const dialog = dialogRef.current;
              resizeStartRef.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                width: dialog.offsetWidth,
                height: dialog.offsetHeight,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = resizeStartRef.current;
              const dialog = dialogRef.current;
              if (!start || !dialog || start.pointerId !== event.pointerId) return;
              const width = Math.min(
                Math.max(360, viewportSize.width - 16),
                Math.max(480, start.width + 2 * (event.clientX - start.x))
              );
              const height = Math.min(
                Math.max(280, viewportSize.height - 44),
                Math.max(420, start.height + 2 * (event.clientY - start.y))
              );
              dialog.style.width = `${width}px`;
              dialog.style.height = `${height}px`;
            }}
            onPointerUp={(event) => finishDialogResize(event.pointerId)}
            onPointerCancel={(event) => finishDialogResize(event.pointerId)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 80 : 24;
              const widthDelta =
                event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
              const heightDelta =
                event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
              if (!widthDelta && !heightDelta) return;
              event.preventDefault();
              event.stopPropagation();
              const dialog = dialogRef.current;
              if (!dialog) return;
              setCustomDialogSize({
                width: Math.min(
                  Math.max(360, viewportSize.width - 16),
                  Math.max(480, dialog.offsetWidth + widthDelta)
                ),
                height: Math.min(
                  Math.max(280, viewportSize.height - 44),
                  Math.max(420, dialog.offsetHeight + heightDelta)
                ),
              });
            }}
          >
            <span
              aria-hidden="true"
              className="block h-2.5 w-2.5 border-r-2 border-b-2 border-current"
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
