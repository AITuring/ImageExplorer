import { memo, useEffect, useMemo, useState } from "react";
import { File, Folder } from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import {
  iconCache,
  loadingIcons,
  loadFileThumbnail,
  registerIconRefresh,
  triggerIconRefresh,
} from "@/lib/iconCache";
import type { FileEntry } from "@/types/index";

const PREVIEWABLE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "dng",
  "svg",
  "pdf",
  "psd",
]);

interface FileThumbnailProps {
  entry: FileEntry;
  size: number;
  className?: string;
  fallbackClassName?: string;
  requestSizeOverride?: number;
  onImageLoad?: (image: HTMLImageElement) => void;
}

export const FileThumbnail = memo(function FileThumbnail({
  entry,
  size,
  className,
  fallbackClassName,
  requestSizeOverride,
  onImageLoad,
}: FileThumbnailProps) {
  const [updateCount, forceUpdate] = useState(0);
  const normalizedExtension = (entry.extension || "").toLowerCase();
  const shouldLoadPreview = !entry.is_dir && PREVIEWABLE_EXTENSIONS.has(normalizedExtension);
  const requestSize = useMemo(() => {
    if (requestSizeOverride) {
      return requestSizeOverride;
    }
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    if (size >= 96) {
      return Math.min(1024, Math.max(512, Math.round(size * Math.max(4, dpr * 2.5))));
    }
    return Math.min(1024, Math.max(512, Math.round(size * Math.max(5, dpr * 3))));
  }, [requestSizeOverride, size]);

  const roundedSize = Math.round(size);
  const cacheKey = useMemo(
    () => `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:${requestSize}`,
    [entry.modified, entry.path, entry.size, requestSize]
  );

  const thumbnailBase64 = useMemo(() => {
    const cached = iconCache[cacheKey];
    return cached === "failed" ? null : cached || null;
  }, [cacheKey, updateCount]);

  useEffect(() => {
    const unregister = registerIconRefresh(() => {
      forceUpdate((count) => count + 1);
    });
    return () => {
      unregister();
    };
  }, []);

  useEffect(() => {
    if (!shouldLoadPreview) {
      return;
    }

    const cachedValue = iconCache[cacheKey];
    if ((cachedValue && cachedValue !== "failed") || loadingIcons.has(cacheKey)) {
      return;
    }
    if (cachedValue === "failed") {
      delete iconCache[cacheKey];
    }

    let isMounted = true;
    loadingIcons.add(cacheKey);

    loadFileThumbnail(cacheKey, entry.path, requestSize)
      .then((base64) => {
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
        loadingIcons.delete(cacheKey);
        triggerIconRefresh();
      });

    return () => {
      isMounted = false;
    };
  }, [cacheKey, entry.extension, entry.path, requestSize, shouldLoadPreview]);

  if (thumbnailBase64) {
    return (
      <img
        src={`data:image/png;base64,${thumbnailBase64}`}
        className={className || "object-contain"}
        style={className ? undefined : { width: roundedSize, height: roundedSize }}
        alt=""
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
      sysIcon={entry.is_dir ? { type: "folder" } : { type: "ext", value: normalizedExtension }}
    />
  );
});
