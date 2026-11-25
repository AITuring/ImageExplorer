import { convertFileSrc } from "@tauri-apps/api/core";
import { IMAGE_EXTENSIONS, RAW_IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import { buildFileThumbnailUrl, buildRawEmbeddedJpegUrl } from "@/lib/iconCache";
import { loadPhotoMetadata } from "@/lib/photoMetadata";
import type { FileEntry } from "@/types";

const RAW_EXT_SET = new Set<string>(RAW_IMAGE_EXTENSIONS);
const IMAGE_EXT_SET = new Set<string>(IMAGE_EXTENSIONS);
const BROWSER_NATIVE_EXT_SET = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"]);

const MAX_PRELOADED_IMAGES = 16;
const preloadedImages = new Map<string, HTMLImageElement>();

function preloadImageUrl(url: string, signal?: AbortSignal) {
  if (!url || signal?.aborted) return;
  const existing = preloadedImages.get(url);
  if (existing) {
    // Refresh LRU position
    preloadedImages.delete(url);
    preloadedImages.set(url, existing);
    return;
  }

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";

  const onAbort = () => {
    if (!image.complete) {
      image.src = "";
      preloadedImages.delete(url);
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  image.onload = () => {
    signal?.removeEventListener("abort", onAbort);
  };
  image.onerror = () => {
    signal?.removeEventListener("abort", onAbort);
    preloadedImages.delete(url);
  };

  preloadedImages.set(url, image);
  while (preloadedImages.size > MAX_PRELOADED_IMAGES) {
    const oldestKey = preloadedImages.keys().next().value as string | undefined;
    if (!oldestKey) break;
    preloadedImages.delete(oldestKey);
  }

  image.src = url;
}

export function buildPreloadPreviewUrl(
  entry: FileEntry,
  mode: "quicklook" | "gallery",
  gallerySize = 1600
): string | null {
  if (entry.is_dir) return null;
  const ext = (entry.extension ?? "").toLowerCase();
  if (!IMAGE_EXT_SET.has(ext)) return null;

  if (RAW_EXT_SET.has(ext)) {
    return mode === "quicklook"
      ? buildRawEmbeddedJpegUrl(entry.path, entry.modified, entry.size, 0)
      : buildFileThumbnailUrl(entry.path, entry.modified, entry.size, gallerySize, true, false);
  }

  if (mode === "quicklook" && BROWSER_NATIVE_EXT_SET.has(ext)) {
    return convertFileSrc(entry.path);
  }

  return buildFileThumbnailUrl(
    entry.path,
    entry.modified,
    entry.size,
    mode === "quicklook" ? 2048 : gallerySize,
    true,
    false
  );
}

/**
 * Warm the browser decoded-image cache and SQLite EXIF cache for neighboring
 * entries (+1, +2, -1) so flipping through photos with arrow keys feels instant.
 */
export function preloadNeighborEntries(
  entries: FileEntry[],
  activeIndex: number,
  mode: "quicklook" | "gallery",
  signal?: AbortSignal
): void {
  if (activeIndex < 0 || entries.length <= 1) return;
  const neighborOffsets = [1, -1, 2];
  for (const offset of neighborOffsets) {
    if (signal?.aborted) return;
    const neighbor = entries[activeIndex + offset];
    if (!neighbor || neighbor.is_dir) continue;
    const url = buildPreloadPreviewUrl(neighbor, mode);
    if (url) {
      preloadImageUrl(url, signal);
      void loadPhotoMetadata(neighbor, signal).catch(() => undefined);
    }
  }
}
