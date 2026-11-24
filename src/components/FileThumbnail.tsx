import { memo, useEffect, useMemo, useRef, useState } from "react";
import { File, Folder } from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import {
  buildFileThumbnailUrl,
  getThumbnailRequestSize,
  isFileThumbnailFailed,
  markFileThumbnailFailed,
  markFileThumbnailLoaded,
} from "@/lib/iconCache";
import type { FileEntry } from "@/types/index";
import { IMAGE_EXTENSIONS, RAW_IMAGE_EXTENSIONS } from "@/constants/fileTypes";

const PREVIEWABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf"]);
const RAW_EXTENSIONS = new Set<string>(RAW_IMAGE_EXTENSIONS);

interface FileThumbnailProps {
  entry: FileEntry;
  size: number;
  className?: string;
  fallbackClassName?: string;
  requestSizeOverride?: number;
  onImageLoad?: (image: HTMLImageElement) => void;
  isScrolling?: boolean;
  isInViewport?: boolean;
}

type ThumbnailStage = "embedded" | "full" | "failed";

interface ThumbnailLoadState {
  identity: string;
  stage: ThumbnailStage;
  loadedUrl: string | null;
}

export const FileThumbnail = memo(function FileThumbnail({
  entry,
  size,
  className,
  fallbackClassName,
  requestSizeOverride,
  onImageLoad,
  isScrolling = false,
  isInViewport = true,
}: FileThumbnailProps) {
  const normalizedExtension = (entry.extension || "").toLowerCase();
  const isRawFile = RAW_EXTENSIONS.has(normalizedExtension);
  const shouldLoadPreview = !entry.is_dir && PREVIEWABLE_EXTENSIONS.has(normalizedExtension);
  const requestSize = useMemo(
    () => getThumbnailRequestSize(size, requestSizeOverride),
    [requestSizeOverride, size]
  );

  const roundedSize = Math.round(size);
  const embeddedUrl = useMemo(
    () =>
      shouldLoadPreview
        ? buildFileThumbnailUrl(entry.path, entry.modified, entry.size, requestSize, true, false)
        : "",
    [entry.modified, entry.path, entry.size, requestSize, shouldLoadPreview]
  );
  // RAW embedded=1 already has a full native fallback chain; never escalate small
  // grid thumbnails to embedded=0 (which triggers slow full-sensor RAW demosaicing).
  const fullUrl = useMemo(
    () =>
      shouldLoadPreview && !isRawFile
        ? buildFileThumbnailUrl(entry.path, entry.modified, entry.size, requestSize, false, false)
        : "",
    [entry.modified, entry.path, entry.size, isRawFile, requestSize, shouldLoadPreview]
  );

  const identity = `${entry.path}\u0000${entry.modified ?? 0}\u0000${entry.size}\u0000${requestSize}`;
  const [loadState, setLoadState] = useState<ThumbnailLoadState>(() => ({
    identity,
    stage: "embedded",
    loadedUrl: null,
  }));

  const currentStage: ThumbnailStage =
    loadState.identity === identity
      ? loadState.stage
      : isFileThumbnailFailed(embeddedUrl)
        ? fullUrl && !isFileThumbnailFailed(fullUrl)
          ? "full"
          : "failed"
        : "embedded";
  const loadedUrl = loadState.identity === identity ? loadState.loadedUrl : null;
  const activeUrl =
    currentStage === "embedded" ? embeddedUrl : currentStage === "full" ? fullUrl : null;
  const isLoaded = Boolean(activeUrl && loadedUrl === activeUrl);
  const shouldRenderImg = Boolean(
    shouldLoadPreview && activeUrl && (isLoaded || (isInViewport && !isScrolling))
  );
  const pendingImgRef = useRef<HTMLImageElement | null>(null);

  // Abort any in-flight thumbnail fetch as soon as a virtualized cell scrolls
  // out of view or switches identity so rapid scrolling never clogs WebKit's pool.
  // Mark the element aborted before clearing src so WebKit's synthetic error event
  // never poisons failedThumbnailUrls or escalates to full RAW demosaicing.
  useEffect(() => {
    const img = pendingImgRef.current;
    if (img) {
      delete img.dataset.aborted;
    }
    return () => {
      if (img && !img.complete) {
        img.dataset.aborted = "1";
        img.removeAttribute("src");
      }
    };
  }, [activeUrl, shouldRenderImg]);

  if (isLoaded && shouldRenderImg && activeUrl) {
    return (
      <img
        src={activeUrl}
        crossOrigin="anonymous"
        className={className || "object-contain"}
        style={className ? undefined : { width: roundedSize, height: roundedSize }}
        alt=""
        decoding="async"
        draggable={false}
        onLoad={(event) => {
          onImageLoad?.(event.currentTarget);
        }}
      />
    );
  }

  const fallbackIcon = (
    <SmartIcon
      icon={entry.is_dir ? Folder : File}
      className={
        fallbackClassName ||
        (entry.is_dir ? "h-6 w-6 text-blue-500" : "text-muted-foreground h-6 w-6")
      }
      sysIcon={
        entry.is_package
          ? { type: "path", value: entry.path }
          : entry.is_dir
            ? { type: "folder" }
            : { type: "ext", value: normalizedExtension }
      }
    />
  );

  if (!shouldRenderImg || !activeUrl) {
    return fallbackIcon;
  }

  return (
    <>
      {fallbackIcon}
      <img
        ref={pendingImgRef}
        src={activeUrl}
        crossOrigin="anonymous"
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        alt=""
        decoding="async"
        draggable={false}
        onLoad={(event) => {
          markFileThumbnailLoaded(entry.path, entry.modified, entry.size, requestSize, activeUrl);
          setLoadState({ identity, stage: currentStage, loadedUrl: activeUrl });
          onImageLoad?.(event.currentTarget);
        }}
        onError={(event) => {
          if (event.currentTarget.dataset.aborted === "1") {
            return;
          }
          markFileThumbnailFailed(activeUrl);
          if (currentStage === "embedded" && fullUrl && !isFileThumbnailFailed(fullUrl)) {
            setLoadState({ identity, stage: "full", loadedUrl: null });
          } else {
            setLoadState({ identity, stage: "failed", loadedUrl: null });
          }
        }}
      />
    </>
  );
});
