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

const metadataCache = new Map<string, PhotoMetadata | null>();
const pendingMetadata = new Map<string, Promise<PhotoMetadata | null>>();
const metadataQueue: Array<{
  path: string;
  cacheKey: string;
  resolve: (metadata: PhotoMetadata | null) => void;
}> = [];
const MAX_CONCURRENT_METADATA = 2;
let activeMetadataLoads = 0;

export function getPhotoMetadataKey(entry: FileEntry) {
  return `${entry.path}:${entry.modified ?? 0}:${entry.size}`;
}

function pumpMetadataQueue() {
  while (activeMetadataLoads < MAX_CONCURRENT_METADATA && metadataQueue.length > 0) {
    const task = metadataQueue.shift();
    if (!task) return;

    activeMetadataLoads += 1;
    const pending = invoke<PhotoMetadata | null>("read_image_metadata", {
      path: task.path,
    })
      .catch((error) => {
        console.warn("Failed to read image metadata", error);
        return null;
      })
      .then((metadata) => {
        metadataCache.set(task.cacheKey, metadata);
        task.resolve(metadata);
        return metadata;
      })
      .finally(() => {
        activeMetadataLoads = Math.max(0, activeMetadataLoads - 1);
        pendingMetadata.delete(task.cacheKey);
        pumpMetadataQueue();
      });

    // Keep the promise alive through the queue runner. The consumer promise
    // is resolved above so an unmounted card cannot hold up later cards.
    void pending;
  }
}

export function loadPhotoMetadata(entry: FileEntry): Promise<PhotoMetadata | null> {
  const cacheKey = getPhotoMetadataKey(entry);
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = pendingMetadata.get(cacheKey);
  if (existing) return existing;

  const promise = new Promise<PhotoMetadata | null>((resolve) => {
    metadataQueue.push({
      path: entry.path,
      cacheKey,
      resolve,
    });
    pumpMetadataQueue();
  });
  pendingMetadata.set(cacheKey, promise);
  return promise;
}

function firstNumber(value: string | null) {
  if (!value) return null;
  const match = value.match(/[-+]?\d*\.?\d+/);
  return match ? Number(match[0]) : null;
}

function formatAperture(value: string | null) {
  const number = firstNumber(value);
  return number !== null && Number.isFinite(number) ? `f/${number}` : null;
}

function formatFocalLength(value: string | null) {
  const number = firstNumber(value);
  return number !== null && Number.isFinite(number) ? `${number}mm` : null;
}

function formatShutterSpeed(value: string | null) {
  if (!value) return null;
  if (value.includes("/")) return value;
  const number = firstNumber(value);
  if (number === null || !Number.isFinite(number) || number <= 0) return null;
  if (number < 1) return `1/${Math.max(1, Math.round(1 / number))}`;
  return `${number}s`;
}

export function getPhotoMetadataLines(metadata: PhotoMetadata | null | undefined) {
  if (!metadata) return [];

  const exposureLine = [
    metadata.iso ? `ISO ${firstNumber(metadata.iso) ?? metadata.iso}` : null,
    formatAperture(metadata.aperture),
    formatShutterSpeed(metadata.shutterSpeed),
    formatFocalLength(metadata.focalLength),
  ].filter(Boolean) as string[];
  const dimensionLine =
    metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : null;
  const cameraLine = [metadata.model || metadata.make, metadata.lens].filter(Boolean).join(" · ");

  return [[dimensionLine, ...exposureLine].filter(Boolean).join(" · "), cameraLine].filter(Boolean);
}
