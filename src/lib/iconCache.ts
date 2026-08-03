import { invoke } from "@tauri-apps/api/core";
import { SYSTEM_PATHS } from "@/constants/paths";

// 有界内存缓存 - 导出一个兼容对象，内部使用 LRU 淘汰，避免大量缩略图
// 把 WebView 内存无限推高。失败标记也会过期淘汰，不会永久占用缓存槽位。
const MAX_CACHE_ENTRIES = 1200;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const iconCacheEntries = new Map<string, string>();
let iconCacheBytes = 0;

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

function setCacheValue(key: string, value: string) {
  const previous = iconCacheEntries.get(key);
  if (previous !== undefined) {
    iconCacheBytes -= valueBytes(previous);
    iconCacheEntries.delete(key);
  }
  iconCacheEntries.set(key, value);
  iconCacheBytes += valueBytes(value);

  while (
    iconCacheEntries.size > MAX_CACHE_ENTRIES ||
    iconCacheBytes > MAX_CACHE_BYTES
  ) {
    const oldest = iconCacheEntries.keys().next().value as string | undefined;
    if (!oldest) break;
    const oldestValue = iconCacheEntries.get(oldest);
    if (oldestValue !== undefined) iconCacheBytes -= valueBytes(oldestValue);
    iconCacheEntries.delete(oldest);
  }
}

function deleteCacheValue(key: string) {
  const value = iconCacheEntries.get(key);
  if (value !== undefined) {
    iconCacheBytes -= valueBytes(value);
    iconCacheEntries.delete(key);
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
  iconCacheBytes = 0;
}

export function getIconCacheStats() {
  return { entries: iconCacheEntries.size, bytes: iconCacheBytes };
}

// 正在加载的图标集合，避免重复请求
export const loadingIcons = new Set<string>();
const pendingLoads = new Map<string, Promise<string | null>>();
export type ThumbnailLoadPriority = "interactive" | "background";

interface QueuedThumbnailTask {
  priority: ThumbnailLoadPriority;
  run: () => void;
}

const queuedThumbnailTasks = new Map<string, QueuedThumbnailTask>();
const queuedTaskKeys: string[] = [];
// Keep enough slots for two background analyses while visible grid previews
// are loading. Embedded RAW previews are small and do not need the old
// three-process ceiling that made analysis wait behind the first cards.
const MAX_CONCURRENT_THUMBNAILS = 5;
const RESERVED_BACKGROUND_THUMBNAILS = 2;
let activeThumbnailLoads = 0;

// 全局刷新回调列表
const refreshCallbacks = new Set<() => void>();

// Keep the request size in one place so visible thumbnails and background
// analysis can share the native thumbnail/cache entry.
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

// 注册刷新回调
export function registerIconRefresh(callback: () => void) {
  refreshCallbacks.add(callback);
  return () => refreshCallbacks.delete(callback);
}

// 触发全局图标刷新
export function triggerIconRefresh() {
  refreshCallbacks.forEach((callback) => callback());
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
    // Keep two slots available for focus/group analysis once background work
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
    if (!task) {
      continue;
    }

    queuedThumbnailTasks.delete(cacheKey);
    activeThumbnailLoads += 1;
    task.run();
  }
}

export function loadFileThumbnail(
  cacheKey: string,
  path: string,
  size: number,
  allowIconFallback = true,
  signal?: AbortSignal,
  priority: ThumbnailLoadPriority = "interactive",
  preferEmbedded = false
): Promise<string | null> {
  if (signal?.aborted) {
    return Promise.resolve(null);
  }

  const cached = iconCache[cacheKey];
  if (cached === "failed") return Promise.resolve(null);
  if (cached) return Promise.resolve(cached);

  if (pendingLoads.has(cacheKey)) {
    const queuedTask = queuedThumbnailTasks.get(cacheKey);
    if (queuedTask && priority === "interactive") {
      queuedTask.priority = "interactive";
    }
    bumpQueuedTask(cacheKey);
    return pendingLoads.get(cacheKey)!;
  }

  const task = new Promise<string | null>((resolve) => {
    let started = false;
    let settled = false;
    const cancelQueuedTask = () => {
      if (started || settled) return;
      settled = true;
      queuedThumbnailTasks.delete(cacheKey);
      pendingLoads.delete(cacheKey);
      resolve(null);
    };

    signal?.addEventListener("abort", cancelQueuedTask, { once: true });
    queuedThumbnailTasks.set(cacheKey, {
      priority,
      run: () => {
        if (settled) return;
        started = true;
        signal?.removeEventListener("abort", cancelQueuedTask);
        if (signal?.aborted) {
          settled = true;
          activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
          pendingLoads.delete(cacheKey);
          resolve(null);
          runNextThumbnailTask();
          return;
        }

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
            if (base64) iconCache[cacheKey] = base64;
            resolve(base64);
          })
          .finally(() => {
            settled = true;
            activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
            pendingLoads.delete(cacheKey);
            runNextThumbnailTask();
          });
      },
    });

    queuedTaskKeys.unshift(cacheKey);
    runNextThumbnailTask();
  });

  pendingLoads.set(cacheKey, task);
  return task;
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
    triggerIconRefresh();
  }
}
