import { invoke } from "@tauri-apps/api/core";
import { SYSTEM_PATHS } from "@/constants/paths";

// 有界内存缓存 - 导出一个兼容对象，内部使用 LRU 淘汰，避免大量缩略图
// 把 WebView 内存无限推高。失败标记也会过期淘汰，不会永久占用缓存槽位。
const MAX_CACHE_ENTRIES = 1200;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const iconCacheEntries = new Map<string, string>();
const retainedCacheKeyCounts = new Map<string, number>();
// Secondary index mapping `file:<path>:<mtime>:<size>:` -> cached keys so
// `getLargestCachedFileThumbnail` is O(variants) instead of scanning all 1200 entries.
const thumbnailKeysByPrefix = new Map<string, Set<string>>();
let iconCacheBytes = 0;

function extractThumbnailPrefix(key: string): string | null {
  if (!key.startsWith("file:")) return null;
  // Format: file:<path>:<modified>:<fileSize>:<requestSize>[:embedded]
  // Note: path may contain colons on some systems; find the last 3 numeric/flag segments.
  const withoutFlag = key.endsWith(":embedded") ? key.slice(0, -":embedded".length) : key;
  const lastColon = withoutFlag.lastIndexOf(":");
  if (lastColon <= 5) return null;
  return withoutFlag.slice(0, lastColon + 1);
}

function indexThumbnailKey(key: string) {
  const prefix = extractThumbnailPrefix(key);
  if (!prefix) return;
  let bucket = thumbnailKeysByPrefix.get(prefix);
  if (!bucket) {
    bucket = new Set<string>();
    thumbnailKeysByPrefix.set(prefix, bucket);
  }
  bucket.add(key);
}

function unindexThumbnailKey(key: string) {
  const prefix = extractThumbnailPrefix(key);
  if (!prefix) return;
  const bucket = thumbnailKeysByPrefix.get(prefix);
  if (!bucket) return;
  bucket.delete(key);
  if (bucket.size === 0) thumbnailKeysByPrefix.delete(prefix);
}

function valueBytes(value: string) {
  return value.length * 2;
}

function touchCacheKey(key: string) {
  const value = iconCacheEntries.get(key);
  if (value !== undefined) {
    iconCacheEntries.delete(key);
    iconCacheEntries.set(key, value);
  }
  return value;
}

function getOldestEvictableCacheKey() {
  for (const cacheKey of iconCacheEntries.keys()) {
    if (!retainedCacheKeyCounts.has(cacheKey)) return cacheKey;
  }
  return iconCacheEntries.keys().next().value as string | undefined;
}

function setCacheValue(key: string, value: string) {
  const previous = iconCacheEntries.get(key);
  if (previous !== undefined) {
    iconCacheBytes -= valueBytes(previous);
    iconCacheEntries.delete(key);
  }
  iconCacheEntries.set(key, value);
  indexThumbnailKey(key);
  iconCacheBytes += valueBytes(value);

  while (iconCacheEntries.size > MAX_CACHE_ENTRIES || iconCacheBytes > MAX_CACHE_BYTES) {
    const oldest = getOldestEvictableCacheKey();
    if (!oldest) break;
    const oldestValue = iconCacheEntries.get(oldest);
    if (oldestValue !== undefined) iconCacheBytes -= valueBytes(oldestValue);
    iconCacheEntries.delete(oldest);
    unindexThumbnailKey(oldest);
  }
}

function deleteCacheValue(key: string) {
  const value = iconCacheEntries.get(key);
  if (value !== undefined) {
    iconCacheBytes -= valueBytes(value);
    iconCacheEntries.delete(key);
    unindexThumbnailKey(key);
    return true;
  }
  return false;
}

// Existing callers intentionally use property access (iconCache[key]). A Proxy
// keeps that API while enforcing LRU accounting and making Object.entries work.
export const iconCache = new Proxy<Record<string, string>>({} as Record<string, string>, {
  get: (_target, key: string | symbol) =>
    typeof key === "string" ? touchCacheKey(key) : undefined,
  set: (_target, key: string | symbol, value: string) => {
    if (typeof key !== "string") return false;
    setCacheValue(key, value);
    return true;
  },
  deleteProperty: (_target, key: string | symbol) =>
    typeof key === "string" ? deleteCacheValue(key) : false,
  has: (_target, key: string | symbol) =>
    typeof key === "string" ? iconCacheEntries.has(key) : false,
  ownKeys: () => [...iconCacheEntries.keys()],
  getOwnPropertyDescriptor: (_target, key: string | symbol) =>
    typeof key === "string" && iconCacheEntries.has(key)
      ? { enumerable: true, configurable: true, value: iconCacheEntries.get(key) }
      : undefined,
});

export function clearIconCache() {
  iconCacheEntries.clear();
  thumbnailKeysByPrefix.clear();
  iconCacheBytes = 0;
}

/** Keep mounted grid thumbnails from being evicted by a large Quick Look frame. */
export function retainIconCacheKey(cacheKey: string) {
  retainedCacheKeyCounts.set(cacheKey, (retainedCacheKeyCounts.get(cacheKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const nextCount = (retainedCacheKeyCounts.get(cacheKey) ?? 1) - 1;
    if (nextCount <= 0) {
      retainedCacheKeyCounts.delete(cacheKey);
    } else {
      retainedCacheKeyCounts.set(cacheKey, nextCount);
    }
  };
}

export function getIconCacheStats() {
  return { entries: iconCacheEntries.size, bytes: iconCacheBytes };
}

// 正在加载的图标集合，避免重复请求
export const loadingIcons = new Set<string>();
interface PendingThumbnailLoad {
  promise: Promise<string | null>;
  consumers: Set<symbol>;
  started: boolean;
  settled: boolean;
  cacheResult: boolean;
  cancelQueued: () => void;
}

const pendingLoads = new Map<string, PendingThumbnailLoad>();
export type ThumbnailLoadPriority = "interactive" | "background";

interface QueuedThumbnailTask {
  priority: ThumbnailLoadPriority;
  run: () => void;
}

const queuedThumbnailTasks = new Map<string, QueuedThumbnailTask>();
const queuedTaskKeys: string[] = [];
// Keep one slot for background analysis while visible grid previews
// are loading. Embedded RAW previews are small and do not need the old
// three-process ceiling that made analysis wait behind the first cards.
const MAX_CONCURRENT_THUMBNAILS = 4;
const RESERVED_BACKGROUND_THUMBNAILS = 1;
let activeThumbnailLoads = 0;

// Keep refresh notifications local to the cache key. A global callback made
// every visible card render again whenever any other card finished decoding.
const refreshCallbacks = new Set<() => void>();
const keyedRefreshCallbacks = new Map<string, Set<() => void>>();

// Keep the request size in one place so visible thumbnails and background
// analysis can share the native thumbnail/cache entry.
export function toImageDataUrl(base64: string): string {
  if (base64.startsWith("data:") || base64.startsWith("thumb:") || base64.startsWith("asset:")) {
    return base64;
  }
  if (base64.startsWith("/9j/")) return `data:image/jpeg;base64,${base64}`;
  if (base64.startsWith("UklGR")) return `data:image/webp;base64,${base64}`;
  return `data:image/png;base64,${base64}`;
}

/**
 * 构建自定义 `thumb://` 二进制缩略图 URL。
 * 由 Rust 异步协议处理器直接返回原始 JPEG/PNG 字节，彻底消除 Base64 传输与 JS 堆驻留。
 */
export function buildFileThumbnailUrl(
  path: string,
  modified: number | null | undefined,
  fileSize: number,
  size: number,
  preferEmbedded = false,
  allowIconFallback = false
): string {
  const params = new URLSearchParams({
    path,
    size: String(Math.round(size)),
    embedded: preferEmbedded ? "1" : "0",
    fallback: allowIconFallback ? "1" : "0",
    v: `${modified ?? 0}-${fileSize}`,
  });
  return `thumb://localhost/file?${params.toString()}`;
}

export function buildRawEmbeddedJpegUrl(
  path: string,
  modified: number | null | undefined,
  fileSize: number,
  maxPixelSize: number
): string {
  const params = new URLSearchParams({
    path,
    max: String(Math.round(maxPixelSize)),
    v: `${modified ?? 0}-${fileSize}`,
  });
  return `thumb://localhost/raw?${params.toString()}`;
}

export const buildArwEmbeddedJpegUrl = buildRawEmbeddedJpegUrl;

// 轻量元数据索引：仅记录已成功加载/失败的 `thumb://` URL（不存任何 Base64 字节）
const MAX_LOADED_URL_RECORDS = 4_000;
const loadedThumbnailUrlsByFile = new Map<string, { requestSize: number; url: string }>();
const failedThumbnailUrls = new Set<string>();

function fileUrlIdentity(path: string, modified: number | null | undefined, fileSize: number) {
  return `${path}\u0000${modified ?? 0}\u0000${fileSize}`;
}

export function markFileThumbnailLoaded(
  path: string,
  modified: number | null | undefined,
  fileSize: number,
  requestSize: number,
  url: string
) {
  failedThumbnailUrls.delete(url);
  const id = fileUrlIdentity(path, modified, fileSize);
  const existing = loadedThumbnailUrlsByFile.get(id);
  if (!existing || requestSize >= existing.requestSize) {
    loadedThumbnailUrlsByFile.delete(id);
    loadedThumbnailUrlsByFile.set(id, { requestSize, url });
    while (loadedThumbnailUrlsByFile.size > MAX_LOADED_URL_RECORDS) {
      const oldest = loadedThumbnailUrlsByFile.keys().next().value as string | undefined;
      if (!oldest) break;
      loadedThumbnailUrlsByFile.delete(oldest);
    }
  }
}

export function markFileThumbnailFailed(url: string) {
  failedThumbnailUrls.add(url);
  if (failedThumbnailUrls.size > MAX_LOADED_URL_RECORDS) {
    const oldest = failedThumbnailUrls.values().next().value as string | undefined;
    if (oldest) failedThumbnailUrls.delete(oldest);
  }
}

export function isFileThumbnailFailed(url: string) {
  return failedThumbnailUrls.has(url);
}

export function getLargestLoadedFileThumbnailUrl(
  path: string,
  modified: number | null | undefined,
  fileSize: number
): { requestSize: number; url: string } | null {
  const entry = loadedThumbnailUrlsByFile.get(fileUrlIdentity(path, modified, fileSize));
  if (entry) return entry;
  const legacy = getLargestCachedFileThumbnail(path, modified, fileSize);
  if (legacy) {
    return { requestSize: legacy.requestSize, url: toImageDataUrl(legacy.base64) };
  }
  return null;
}

/**
 * 通过 `thumb://` 等 URL 加载可安全读取像素的 HTMLImageElement（设置 crossOrigin="anonymous" 防止 canvas 污染）。
 */
export function loadHtmlImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Image load was cancelled", "AbortError"));
      return;
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";

    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      image.src = "";
      reject(new DOMException("Image load was cancelled", "AbortError"));
    };

    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(`Unable to load image: ${url}`));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    image.src = url;
  });
}

export function getThumbnailRequestSize(size: number, requestSizeOverride?: number) {
  if (requestSizeOverride) return requestSizeOverride;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const pixelRatio = Math.max(1.5, Math.min(2.5, dpr));
  const minimumSize = size >= 96 ? 240 : 160;
  return Math.min(768, Math.max(minimumSize, Math.round(size * pixelRatio)));
}

export function getFileThumbnailCacheKey(
  path: string,
  modified: number | null | undefined,
  fileSize: number,
  requestSize: number,
  preferEmbedded = false
) {
  const previewKind = preferEmbedded ? ":embedded" : "";
  return `file:${path}:${modified ?? 0}:${fileSize}:${requestSize}${previewKind}`;
}

export function getLargestCachedFileThumbnail(
  path: string,
  modified: number | null | undefined,
  fileSize: number
) {
  const prefix = `file:${path}:${modified ?? 0}:${fileSize}:`;
  const candidateKeys = thumbnailKeysByPrefix.get(prefix);
  if (!candidateKeys || candidateKeys.size === 0) return null;

  let bestMatch: { requestSize: number; base64: string } | null = null;
  for (const cacheKey of candidateKeys) {
    const value = iconCacheEntries.get(cacheKey);
    if (!value || value === "failed") continue;
    // Embedded previews append ":embedded" to the size token. Parse the
    // numeric part so those previews can also seed Quick Look immediately.
    const requestSize = Number(cacheKey.slice(prefix.length).split(":", 1)[0]);
    if (!Number.isFinite(requestSize)) continue;
    if (!bestMatch || requestSize > bestMatch.requestSize) {
      bestMatch = { requestSize, base64: value };
    }
  }

  return bestMatch;
}

// 注册刷新回调
export function registerIconRefresh(callback: () => void) {
  refreshCallbacks.add(callback);
  return () => refreshCallbacks.delete(callback);
}

export function registerIconRefreshForKey(cacheKey: string, callback: () => void) {
  const callbacks = keyedRefreshCallbacks.get(cacheKey) ?? new Set<() => void>();
  callbacks.add(callback);
  keyedRefreshCallbacks.set(cacheKey, callbacks);
  return () => {
    callbacks.delete(callback);
    if (callbacks.size === 0) keyedRefreshCallbacks.delete(cacheKey);
  };
}

// 触发全局图标刷新
export function triggerIconRefresh() {
  refreshCallbacks.forEach((callback) => callback());
  // Preserve the rare global-refresh path used by indexing/preload callers,
  // while normal thumbnail completion stays scoped to one cache key.
  keyedRefreshCallbacks.forEach((callbacks) => {
    callbacks.forEach((callback) => callback());
  });
}

export function triggerIconRefreshForKey(cacheKey: string) {
  keyedRefreshCallbacks.get(cacheKey)?.forEach((callback) => callback());
}

function removeQueuedTask(cacheKey: string) {
  const index = queuedTaskKeys.indexOf(cacheKey);
  if (index >= 0) queuedTaskKeys.splice(index, 1);
}

function bumpQueuedTask(cacheKey: string) {
  const index = queuedTaskKeys.indexOf(cacheKey);
  if (index >= 0) {
    queuedTaskKeys.splice(index, 1);
    const task = queuedThumbnailTasks.get(cacheKey);
    if (task?.priority === "background") {
      queuedTaskKeys.push(cacheKey);
    } else {
      queuedTaskKeys.unshift(cacheKey);
    }
  }
}

function runNextThumbnailTask() {
  while (activeThumbnailLoads < MAX_CONCURRENT_THUMBNAILS && queuedTaskKeys.length > 0) {
    const backgroundIndex = queuedTaskKeys.findIndex(
      (cacheKey) => queuedThumbnailTasks.get(cacheKey)?.priority === "background"
    );
    const interactiveIndex = queuedTaskKeys.findIndex(
      (cacheKey) => queuedThumbnailTasks.get(cacheKey)?.priority === "interactive"
    );
    // Keep one slot available for focus/group analysis once background work
    // is queued. Without a reservation, a burst of visible cards can keep the
    // analysis queue at 0 until every overscanned row has finished decoding.
    const reserveBackgroundSlot =
      backgroundIndex >= 0 &&
      activeThumbnailLoads >= MAX_CONCURRENT_THUMBNAILS - RESERVED_BACKGROUND_THUMBNAILS;
    const nextIndex = reserveBackgroundSlot
      ? backgroundIndex
      : interactiveIndex >= 0
        ? interactiveIndex
        : backgroundIndex >= 0
          ? backgroundIndex
          : 0;
    const cacheKey = queuedTaskKeys.splice(nextIndex, 1)[0];
    if (!cacheKey) {
      return;
    }

    const task = queuedThumbnailTasks.get(cacheKey);
    const pending = pendingLoads.get(cacheKey);
    if (!task || !pending) {
      continue;
    }

    queuedThumbnailTasks.delete(cacheKey);
    activeThumbnailLoads += 1;
    task.run();
  }
}

function subscribeToThumbnailLoad(
  pending: PendingThumbnailLoad,
  signal?: AbortSignal
): Promise<string | null> {
  const consumer = Symbol("thumbnail-consumer");
  pending.consumers.add(consumer);

  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
      pending.consumers.delete(consumer);
    };

    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const handleAbort = () => {
      finish(null);
      if (pending.consumers.size === 0) pending.cancelQueued();
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
    pending.promise.then(finish, () => finish(null));
  });
}

// High-resolution Quick Look/analysis frames can opt out of the shared grid
// cache; the native cache and the current preview still retain those results.
export function loadFileThumbnail(
  cacheKey: string,
  path: string,
  size: number,
  allowIconFallback = true,
  signal?: AbortSignal,
  priority: ThumbnailLoadPriority = "interactive",
  preferEmbedded = false,
  cacheResult = true
): Promise<string | null> {
  if (signal?.aborted) {
    return Promise.resolve(null);
  }

  const cached = iconCache[cacheKey];
  if (cached === "failed") return Promise.resolve(null);
  if (cached) return Promise.resolve(cached);

  const existing = pendingLoads.get(cacheKey);
  if (existing) {
    // A shared request is allowed to upgrade to caching when a visible grid
    // consumer joins a Quick Look/analysis request before it finishes.
    if (cacheResult) existing.cacheResult = true;
    const queuedTask = queuedThumbnailTasks.get(cacheKey);
    if (queuedTask && priority === "interactive") {
      queuedTask.priority = "interactive";
    }
    bumpQueuedTask(cacheKey);
    return subscribeToThumbnailLoad(existing, signal);
  }

  let resolveLoad!: (value: string | null) => void;
  const pending: PendingThumbnailLoad = {
    promise: new Promise<string | null>((resolve) => {
      resolveLoad = resolve;
    }),
    consumers: new Set<symbol>(),
    started: false,
    settled: false,
    cacheResult,
    cancelQueued: () => undefined,
  };

  pending.cancelQueued = () => {
    if (pending.started || pending.settled) return;
    pending.settled = true;
    removeQueuedTask(cacheKey);
    queuedThumbnailTasks.delete(cacheKey);
    pendingLoads.delete(cacheKey);
    resolveLoad(null);
    runNextThumbnailTask();
  };

  pendingLoads.set(cacheKey, pending);
  queuedThumbnailTasks.set(cacheKey, {
    priority,
    run: () => {
      if (pending.settled) return;
      pending.started = true;

      invoke<string | null>("get_file_thumbnail", {
        path,
        size,
        ...(allowIconFallback ? {} : { allowIconFallback: false }),
        ...(preferEmbedded ? { preferEmbedded: true } : {}),
      })
        .catch((error) => {
          console.error(`Failed to load file thumbnail: ${path}`, error);
          return null;
        })
        .then((base64) => {
          if (base64 && pending.cacheResult) iconCache[cacheKey] = base64;
          resolveLoad(base64);
        })
        .finally(() => {
          pending.settled = true;
          activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
          pendingLoads.delete(cacheKey);
          runNextThumbnailTask();
        });
    },
  });

  queuedTaskKeys.unshift(cacheKey);
  runNextThumbnailTask();
  return subscribeToThumbnailLoad(pending, signal);
}

// 预加载图标的辅助函数
export async function preloadIcon(type: string, value: string): Promise<void> {
  const cacheKey = `${type}:${value}`;

  if (iconCache[cacheKey] || loadingIcons.has(cacheKey)) {
    return;
  }

  loadingIcons.add(cacheKey);

  try {
    let base64: string | null = null;

    if (type === "path") {
      base64 = await invoke<string>("get_app_icon", { appPath: value });
    } else if (type === "ext") {
      base64 = await invoke<string>("get_file_type_icon", { ext: value });
    } else if (type === "folder") {
      base64 = await invoke<string>("get_app_icon", {
        appPath: SYSTEM_PATHS.CORE_SERVICES,
      });
    } else if (type === "sfsymbol") {
      base64 = await invoke<string>("get_sf_symbol", { name: value });
    }

    if (base64) {
      iconCache[cacheKey] = base64;
    }
  } catch (e) {
    console.error("Failed to preload icon:", e);
  } finally {
    loadingIcons.delete(cacheKey);
    triggerIconRefreshForKey(cacheKey);
  }
}
