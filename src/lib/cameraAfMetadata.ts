import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "@/types";
import type { FocusRegion } from "@/lib/photoAnalysis";

export type CameraAfSource = "camera-maker-note" | "unavailable";

export interface CameraAfMetadata {
  source: CameraAfSource;
  /** True only when the rectangle dimensions and coordinates came from the file. */
  exact: boolean;
  regions: FocusRegion[];
  areaMode: string | null;
  focusMode: string | null;
  selectedPoint: string | null;
  pointsUsed: number | null;
  extractor: string | null;
  note: string | null;
}

export type CameraAfLoadPriority = "interactive" | "background";

const cache = new Map<string, CameraAfMetadata | null>();
interface PendingCameraAfLoad {
  promise: Promise<CameraAfMetadata | null>;
  entry: FileEntry;
  key: string;
  priority: CameraAfLoadPriority;
  consumers: Set<symbol>;
  started: boolean;
  settled: boolean;
  resolve: (metadata: CameraAfMetadata | null) => void;
  cancelQueued: () => void;
}

const pending = new Map<string, PendingCameraAfLoad>();
const queue: PendingCameraAfLoad[] = [];
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_CACHE_ENTRIES = 300;

export function getCameraAfMetadataKey(entry: FileEntry) {
  return `${entry.path}:${entry.modified ?? 0}:${entry.size}`;
}

export function getCachedCameraAfMetadata(entry: FileEntry): CameraAfMetadata | null | undefined {
  return cache.get(getCameraAfMetadataKey(entry));
}

function cacheCameraAfMetadata(key: string, metadata: CameraAfMetadata | null) {
  cache.delete(key);
  cache.set(key, metadata);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function pumpQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const interactiveIndex = queue.findIndex((task) => task.priority === "interactive");
    const task = queue.splice(interactiveIndex >= 0 ? interactiveIndex : 0, 1)[0];
    if (!task) return;
    if (task.settled) continue;

    task.started = true;

    activeRequests += 1;
    void invoke<CameraAfMetadata | null>("read_camera_af_metadata", {
      path: task.entry.path,
    })
      .catch((error) => {
        // ExifTool is optional. A missing executable is intentionally treated
        // as “no camera AF data”, so the UI can use the clearly-labelled estimate.
        console.debug("Camera AF metadata unavailable", error);
        return null;
      })
      .then((metadata) => {
        cacheCameraAfMetadata(task.key, metadata);
        task.resolve(metadata);
      })
      .finally(() => {
        task.settled = true;
        activeRequests = Math.max(0, activeRequests - 1);
        pending.delete(task.key);
        pumpQueue();
      });
  }
}

function subscribeToCameraAfLoad(
  task: PendingCameraAfLoad,
  signal?: AbortSignal
): Promise<CameraAfMetadata | null> {
  const consumer = Symbol("camera-af-consumer");
  task.consumers.add(consumer);

  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
      task.consumers.delete(consumer);
    };

    const finish = (value: CameraAfMetadata | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const handleAbort = () => {
      finish(null);
      if (task.consumers.size === 0) task.cancelQueued();
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
    task.promise.then(finish, () => finish(null));
  });
}

export function loadCameraAfMetadata(
  entry: FileEntry,
  priority: CameraAfLoadPriority = "background",
  signal?: AbortSignal
): Promise<CameraAfMetadata | null> {
  if (signal?.aborted) return Promise.resolve(null);

  const key = getCameraAfMetadataKey(entry);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = pending.get(key);
  if (existing) {
    if (priority === "interactive") {
      const queuedTask = queue.find((task) => task.key === key);
      if (queuedTask) queuedTask.priority = "interactive";
    }
    return subscribeToCameraAfLoad(existing, signal);
  }

  let resolvePending!: (metadata: CameraAfMetadata | null) => void;
  const task: PendingCameraAfLoad = {
    promise: new Promise<CameraAfMetadata | null>((resolve) => {
      resolvePending = resolve;
    }),
    entry,
    key,
    priority,
    consumers: new Set<symbol>(),
    started: false,
    settled: false,
    resolve: (metadata) => resolvePending(metadata),
    cancelQueued: () => undefined,
  };

  task.cancelQueued = () => {
    if (task.started || task.settled) return;
    const queueIndex = queue.indexOf(task);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);
    task.settled = true;
    pending.delete(key);
    task.resolve(null);
    pumpQueue();
  };

  pending.set(key, task);
  queue.push(task);
  pumpQueue();
  return subscribeToCameraAfLoad(task, signal);
}

/**
 * A MakerNote result with no drawable coordinates must suppress the heuristic
 * marker. Otherwise an estimate could be mistaken for the camera's AF frame.
 */
export function getCameraAfRegions(metadata: CameraAfMetadata | null | undefined) {
  if (!metadata || metadata.source !== "camera-maker-note") return null;
  return metadata.regions;
}
