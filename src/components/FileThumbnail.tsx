import { memo, useEffect, useMemo, useState } from "react";
import { File, Folder } from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import {
  iconCache,
  loadFileThumbnail,
  registerIconRefreshForKey,
  retainIconCacheKey,
  triggerIconRefreshForKey,
  getFileThumbnailCacheKey,
  getThumbnailRequestSize,
} from "@/lib/iconCache";
import type { FileEntry } from "@/types/index";
import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";

const PREVIEWABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf"]);

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
  const [, forceUpdate] = useState(0);
  const normalizedExtension = (entry.extension || "").toLowerCase();
  const shouldLoadPreview = !entry.is_dir && PREVIEWABLE_EXTENSIONS.has(normalizedExtension);
  const shouldRequestPreview = shouldLoadPreview && (!isScrolling || isInViewport);
  const requestSize = useMemo(
    () => getThumbnailRequestSize(size, requestSizeOverride),
    [requestSizeOverride, size]
  );

  const roundedSize = Math.round(size);
  const cacheKey = useMemo(
    () => getFileThumbnailCacheKey(entry.path, entry.modified, entry.size, requestSize, true),
    [entry.modified, entry.path, entry.size, requestSize]
  );

  const cachedThumbnail = iconCache[cacheKey];
  const thumbnailBase64 = cachedThumbnail === "failed" ? null : cachedThumbnail || null;

  useEffect(() => {
    if (!shouldRequestPreview) return;
    const releaseCacheKey = retainIconCacheKey(cacheKey);
    const unregister = registerIconRefreshForKey(cacheKey, () => {
      forceUpdate((count) => count + 1);
    });
    return () => {
      unregister();
      releaseCacheKey();
    };
  }, [cacheKey, shouldRequestPreview]);

  useEffect(() => {
    if (!shouldRequestPreview) {
      return;
    }

    const cachedValue = iconCache[cacheKey];
    if (cachedValue && cachedValue !== "failed") {
      return;
    }
    if (cachedValue === "failed") {
      delete iconCache[cacheKey];
    }

    let isMounted = true;
    const controller = new AbortController();

    // Image previews already render a file icon when decoding fails, so avoid
    // asking the native bridge for a generic icon. This also lets analysis and
    // visible thumbnails share the same in-flight/cache entry safely.
    const loadPreview = loadFileThumbnail(
      cacheKey,
      entry.path,
      requestSize,
      false,
      controller.signal,
      "interactive",
      true
    ).then(async (base64) => {
      if (base64 || controller.signal.aborted) return base64;

      // The embedded RAW path is intentionally preferred for large folders,
      // but a few camera files expose no usable embedded frame. Retry through
      // the full native compatibility path before showing the document icon.
      const fallbackKey = getFileThumbnailCacheKey(
        entry.path,
        entry.modified,
        entry.size,
        requestSize,
        false
      );
      const fallback = await loadFileThumbnail(
        fallbackKey,
        entry.path,
        requestSize,
        false,
        controller.signal,
        "interactive",
        false
      );
      if (fallback) iconCache[cacheKey] = fallback;
      return fallback;
    });

    loadPreview
      .then((base64) => {
        if (controller.signal.aborted) return;
        iconCache[cacheKey] = base64 || "failed";
        if (isMounted) {
          forceUpdate((count) => count + 1);
        }
      })
      .catch((error) => {
        console.error(`Failed to load file thumbnail: ${entry.path}`, error);
        iconCache[cacheKey] = "failed";
      })
      .finally(() => {
        if (!controller.signal.aborted) triggerIconRefreshForKey(cacheKey);
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [
    cacheKey,
    entry.extension,
    entry.modified,
    entry.path,
    entry.size,
    requestSize,
    shouldRequestPreview,
  ]);

  if (thumbnailBase64) {
    return (
      <img
        src={`data:image/png;base64,${thumbnailBase64}`}
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

  return (
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
});
