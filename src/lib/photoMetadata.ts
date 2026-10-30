import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "@/types";

export interface PhotoMetadata {
  width: number | null;
  height: number | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  iso: string | null;
  shutterSpeed: string | null;
  aperture: string | null;
  focalLength: string | null;
  capturedAt: string | null;
}

export interface PhotoMetadataSummary {
  dimensions: string | null;
  exposure: string[];
  camera: string[];
}

const metadataCache = new Map<string, PhotoMetadata | null>();
const MAX_METADATA_CACHE_ENTRIES = 500;
interface PendingMetadataLoad {
  promise: Promise<PhotoMetadata | null>;
  cacheKey: string;
  path: string;
  consumers: Set<symbol>;
  started: boolean;
  settled: boolean;
  resolve: (metadata: PhotoMetadata | null) => void;
  cancelQueued: () => void;
}

const pendingMetadata = new Map<string, PendingMetadataLoad>();
const metadataQueue: PendingMetadataLoad[] = [];
const MAX_CONCURRENT_METADATA = 2;
let activeMetadataLoads = 0;

function cacheMetadata(key: string, metadata: PhotoMetadata | null) {
  metadataCache.delete(key);
  metadataCache.set(key, metadata);
  while (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
    const oldest = metadataCache.keys().next().value as string | undefined;
    if (!oldest) break;
    metadataCache.delete(oldest);
  }
}

export function getPhotoMetadataKey(entry: FileEntry) {
  return `${entry.path}:${entry.modified ?? 0}:${entry.size}`;
}

export function getCachedPhotoMetadata(entry: FileEntry): PhotoMetadata | null | undefined {
  return metadataCache.get(getPhotoMetadataKey(entry));
}

function pumpMetadataQueue() {
  while (activeMetadataLoads < MAX_CONCURRENT_METADATA && metadataQueue.length > 0) {
    const pending = metadataQueue.shift();
    if (!pending) return;
    if (pending.settled) continue;

    pending.started = true;

    activeMetadataLoads += 1;
    const request = invoke<PhotoMetadata | null>("read_image_metadata", {
      path: pending.path,
    })
      .catch((error) => {
        console.warn("Failed to read image metadata", error);
        return null;
      })
      .then((metadata) => {
        cacheMetadata(pending.cacheKey, metadata);
        pending.resolve(metadata);
        return metadata;
      })
      .finally(() => {
        pending.settled = true;
        activeMetadataLoads = Math.max(0, activeMetadataLoads - 1);
        pendingMetadata.delete(pending.cacheKey);
        pumpMetadataQueue();
      });

    // Keep the promise alive through the queue runner. The consumer promise
    // is resolved above so an unmounted card cannot hold up later cards.
    void request;
  }
}

function subscribeToMetadataLoad(
  pending: PendingMetadataLoad,
  signal?: AbortSignal
): Promise<PhotoMetadata | null> {
  const consumer = Symbol("photo-metadata-consumer");
  pending.consumers.add(consumer);

  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
      pending.consumers.delete(consumer);
    };

    const finish = (value: PhotoMetadata | null) => {
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

export function loadPhotoMetadata(
  entry: FileEntry,
  signal?: AbortSignal
): Promise<PhotoMetadata | null> {
  if (signal?.aborted) return Promise.resolve(null);

  const cacheKey = getPhotoMetadataKey(entry);
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = pendingMetadata.get(cacheKey);
  if (existing) return subscribeToMetadataLoad(existing, signal);

  let resolvePending!: (metadata: PhotoMetadata | null) => void;
  const pending: PendingMetadataLoad = {
    promise: new Promise<PhotoMetadata | null>((resolve) => {
      resolvePending = resolve;
    }),
    cacheKey,
    path: entry.path,
    consumers: new Set<symbol>(),
    started: false,
    settled: false,
    resolve: (metadata) => resolvePending(metadata),
    cancelQueued: () => undefined,
  };

  pending.cancelQueued = () => {
    if (pending.started || pending.settled) return;
    const queueIndex = metadataQueue.indexOf(pending);
    if (queueIndex >= 0) metadataQueue.splice(queueIndex, 1);
    pending.settled = true;
    pendingMetadata.delete(cacheKey);
    pending.resolve(null);
    pumpMetadataQueue();
  };

  pendingMetadata.set(cacheKey, pending);
  metadataQueue.push(pending);
  pumpMetadataQueue();
  return subscribeToMetadataLoad(pending, signal);
}

function firstNumber(value: string | null) {
  if (!value) return null;
  const match = value.match(/[-+]?\d*\.?\d+/);
  return match ? Number(match[0]) : null;
}

function formatAperture(value: string | null) {
  const number = firstNumber(value);
  return number !== null && Number.isFinite(number) ? `f/${Number(number.toFixed(1))}` : null;
}

function formatFocalLength(value: string | null) {
  const number = firstNumber(value);
  return number !== null && Number.isFinite(number) ? `${Number(number.toFixed(1))}mm` : null;
}

function formatShutterSpeed(value: string | null) {
  if (!value) return null;
  if (value.includes("/")) return value;
  const number = firstNumber(value);
  if (number === null || !Number.isFinite(number) || number <= 0) return null;
  if (number < 1) return `1/${Math.max(1, Math.round(1 / number))}`;
  return `${number}s`;
}

export function getPhotoMetadataSummary(
  metadata: PhotoMetadata | null | undefined
): PhotoMetadataSummary | null {
  if (!metadata) return null;

  const exposureLine = [
    metadata.iso ? `ISO ${firstNumber(metadata.iso) ?? metadata.iso}` : null,
    formatAperture(metadata.aperture),
    formatShutterSpeed(metadata.shutterSpeed),
    formatFocalLength(metadata.focalLength),
  ].filter(Boolean) as string[];
  const dimensionLine =
    metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : null;
  return {
    dimensions: dimensionLine,
    exposure: exposureLine,
    camera: [metadata.model || metadata.make, metadata.lens].filter(Boolean) as string[],
  };
}
