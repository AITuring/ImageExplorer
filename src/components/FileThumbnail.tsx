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
import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";

const PREVIEWABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf"]);

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
  const [, forceUpdate] = useState(0);
  const normalizedExtension = (entry.extension || "").toLowerCase();
  const shouldLoadPreview = !entry.is_dir && PREVIEWABLE_EXTENSIONS.has(normalizedExtension);
  const requestSize = useMemo(() => {
    if (requestSizeOverride) {
      return requestSizeOverride;
    }
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    // 缩略图只需要覆盖当前卡片的物理像素，避免对 RAW 文件请求不必要的
    // 512px/1024px 解码结果。Quick Look 预览会单独请求更大的尺寸。
    const pixelRatio = Math.max(1.5, Math.min(2.5, dpr));
    const minimumSize = size >= 96 ? 240 : 160;
    return Math.min(768, Math.max(minimumSize, Math.round(size * pixelRatio)));
  }, [requestSizeOverride, size]);

  const roundedSize = Math.round(size);
  const cacheKey = useMemo(
    () => `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:${requestSize}`,
    [entry.modified, entry.path, entry.size, requestSize]
  );

  const cachedThumbnail = iconCache[cacheKey];
  const thumbnailBase64 = cachedThumbnail === "failed" ? null : cachedThumbnail || null;

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
