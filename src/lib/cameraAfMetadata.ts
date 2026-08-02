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

const cache = new Map<string, CameraAfMetadata | null>();
const pending = new Map<string, Promise<CameraAfMetadata | null>>();
const queue: Array<{
  entry: FileEntry;
  key: string;
  resolve: (metadata: CameraAfMetadata | null) => void;
}> = [];
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 2;

export function getCameraAfMetadataKey(entry: FileEntry) {
  return `${entry.path}:${entry.modified ?? 0}:${entry.size}`;
}

export function loadCameraAfMetadata(entry: FileEntry): Promise<CameraAfMetadata | null> {
  const key = getCameraAfMetadataKey(entry);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = pending.get(key);
  if (existing) return existing;

  const request = new Promise<CameraAfMetadata | null>((resolve) => {
    queue.push({ entry, key, resolve });
    pumpQueue();
  });
  pending.set(key, request);
  return request;
}

function pumpQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const task = queue.shift();
    if (!task) return;

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
        cache.set(task.key, metadata);
        task.resolve(metadata);
      })
      .finally(() => {
        activeRequests = Math.max(0, activeRequests - 1);
        pending.delete(task.key);
        pumpQueue();
      });
  }
}

/**
 * A MakerNote result with no drawable coordinates must suppress the heuristic
 * marker. Otherwise an estimate could be mistaken for the camera's AF frame.
 */
export function getCameraAfRegions(metadata: CameraAfMetadata | null | undefined) {
  if (!metadata || metadata.source !== "camera-maker-note") return null;
  return metadata.regions;
}
