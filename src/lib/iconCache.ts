import { invoke } from "@tauri-apps/api/core";
import { SYSTEM_PATHS } from "@/constants/paths";

// 内存缓存 - 导出以便外部预加载
export const iconCache: Record<string, string> = {};

// 正在加载的图标集合，避免重复请求
export const loadingIcons = new Set<string>();
const pendingLoads = new Map<string, Promise<string | null>>();
const queuedThumbnailTasks = new Map<string, () => void>();
const queuedTaskKeys: string[] = [];
// macOS Quick Look 解码 RAW 时会占用较多 CPU/内存。限制并发能避免大目录
// 首屏同时启动多个 qlmanage 进程，把主线程和磁盘留给滚动、选中与交互。
const MAX_CONCURRENT_THUMBNAILS = 3;
let activeThumbnailLoads = 0;

// 全局刷新回调列表
const refreshCallbacks = new Set<() => void>();

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
    queuedTaskKeys.unshift(cacheKey);
  }
}

function runNextThumbnailTask() {
  while (activeThumbnailLoads < MAX_CONCURRENT_THUMBNAILS && queuedTaskKeys.length > 0) {
    const cacheKey = queuedTaskKeys.shift();
    if (!cacheKey) {
      return;
    }

    const task = queuedThumbnailTasks.get(cacheKey);
    if (!task) {
      continue;
    }

    queuedThumbnailTasks.delete(cacheKey);
    activeThumbnailLoads += 1;
    task();
  }
}

export function loadFileThumbnail(
  cacheKey: string,
  path: string,
  size: number
): Promise<string | null> {
  if (pendingLoads.has(cacheKey)) {
    bumpQueuedTask(cacheKey);
    return pendingLoads.get(cacheKey)!;
  }

  const task = new Promise<string | null>((resolve) => {
    queuedThumbnailTasks.set(cacheKey, () => {
      invoke<string | null>("get_file_thumbnail", { path, size })
        .catch((error) => {
          console.error(`Failed to load file thumbnail: ${path}`, error);
          return null;
        })
        .then(resolve)
        .finally(() => {
          activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
          pendingLoads.delete(cacheKey);
          runNextThumbnailTask();
        });
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
