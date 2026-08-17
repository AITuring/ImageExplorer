import { invoke } from "@tauri-apps/api/core";
import { SYSTEM_PATHS } from "@/constants/paths";

// 有界内存缓存 - 导出一个兼容对象，内部使用 LRU 淘汰，避免大量缩略图
// 把 WebView 内存无限推高。失败标记也会过期淘汰，不会永久占用缓存槽位。
const MAX_CACHE_ENTRIES = 1200;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const iconCacheEntries = new Map<string, string>();
const retainedCacheKeys = new Set<string>();
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

function getOldestEvictableCacheKey() {
  for (const cacheKey of iconCacheEntries.keys()) {
    if (!retainedCacheKeys.has(cacheKey)) return cacheKey;
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
  iconCacheBytes += valueBytes(value);

  while (iconCacheEntries.size > MAX_CACHE_ENTRIES || iconCacheBytes > MAX_CACHE_BYTES) {
    const oldest = getOldestEvictableCacheKey();
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

/** Keep mounted grid thumbnails from being evicted by a large Quick Look frame. */
export function retainIconCacheKey(cacheKey: string) {
  retainedCacheKeys.add(cacheKey);
  return () => retainedCacheKeys.delete(cacheKey);
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
  let bestMatch: { requestSize: number; base64: string } | null = null;

  for (const [cacheKey, value] of iconCacheEntries) {
    if (!cacheKey.startsWith(prefix) || value === "failed") continue;
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
    triggerIconRefresh();
  }
}
