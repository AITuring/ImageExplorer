import { invoke } from "@tauri-apps/api/core";

export type PhotoFlag = "none" | "pick" | "reject";

export interface PhotoCullingState {
  rating: number;
  flag: PhotoFlag;
}

interface PhotoCullingRecord {
  path: string;
  rating: number;
  flag: string;
}

export const DEFAULT_CULLING_STATE: PhotoCullingState = {
  rating: 0,
  flag: "none",
};

const cullingCache = new Map<string, PhotoCullingState>();
const listeners = new Set<() => void>();
const pathListeners = new Map<string, Set<() => void>>();
let snapshotVersion = 0;

function notify(changedPaths?: Iterable<string>) {
  snapshotVersion += 1;
  if (changedPaths) {
    for (const path of changedPaths) {
      const bucket = pathListeners.get(path);
      if (!bucket) continue;
      for (const listener of bucket) {
        listener();
      }
    }
  } else {
    for (const bucket of pathListeners.values()) {
      for (const listener of bucket) {
        listener();
      }
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePhotoCulling(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribePhotoCullingPath(path: string, listener: () => void): () => void {
  let bucket = pathListeners.get(path);
  if (!bucket) {
    bucket = new Set();
    pathListeners.set(path, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket?.delete(listener);
    if (bucket && bucket.size === 0) {
      pathListeners.delete(path);
    }
  };
}

export function getPhotoCullingSnapshotVersion(): number {
  return snapshotVersion;
}

export function getPhotoCullingMap(): ReadonlyMap<string, PhotoCullingState> {
  return cullingCache;
}

export function getPhotoCullingEntry(path: string): PhotoCullingState | undefined {
  return cullingCache.get(path);
}

export function getPhotoCullingState(path: string): PhotoCullingState {
  return cullingCache.get(path) ?? DEFAULT_CULLING_STATE;
}

function normalizeFlag(raw: string): PhotoFlag {
  if (raw === "pick" || raw === "reject") return raw;
  return "none";
}

export async function hydratePhotoCullingStates(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const records = await invoke<PhotoCullingRecord[]>("get_photo_culling_states", { paths });
    const changedPaths: string[] = [];
    for (const record of records) {
      const next: PhotoCullingState = {
        rating: Math.max(0, Math.min(5, Math.round(record.rating))),
        flag: normalizeFlag(record.flag),
      };
      const prev = cullingCache.get(record.path);
      if (!prev || prev.rating !== next.rating || prev.flag !== next.flag) {
        cullingCache.set(record.path, next);
        changedPaths.push(record.path);
      }
    }
    if (changedPaths.length > 0) notify(changedPaths);
  } catch {
    // SQLite may be unavailable in non-Tauri environments; keep in-memory state.
  }
}

export async function updatePhotoCullingStates(
  updates: Array<{ path: string; rating?: number; flag?: PhotoFlag }>
): Promise<void> {
  if (updates.length === 0) return;
  const records: PhotoCullingRecord[] = [];
  const changedPaths: string[] = [];
  for (const update of updates) {
    const prev = cullingCache.get(update.path) ?? DEFAULT_CULLING_STATE;
    const rating =
      update.rating !== undefined
        ? Math.max(0, Math.min(5, Math.round(update.rating)))
        : prev.rating;
    const flag = update.flag !== undefined ? update.flag : prev.flag;
    if (rating === 0 && flag === "none") {
      cullingCache.delete(update.path);
    } else {
      cullingCache.set(update.path, { rating, flag });
    }
    records.push({ path: update.path, rating, flag });
    changedPaths.push(update.path);
  }
  notify(changedPaths);

  try {
    await invoke("set_photo_culling_states", { records });
  } catch (error) {
    console.error("Failed to persist photo culling state:", error);
  }
}

export async function exportXmpSidecars(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  return invoke<number>("export_xmp_sidecars", { paths });
}
