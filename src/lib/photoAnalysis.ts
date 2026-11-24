import { invoke } from "@tauri-apps/api/core";
import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import type { FileEntry } from "@/types";
import {
  buildFileThumbnailUrl,
  getLargestLoadedFileThumbnailUrl,
  getThumbnailRequestSize,
  loadHtmlImage,
} from "@/lib/iconCache";
import { groupPhotoFeatures } from "@/lib/photoGrouping";
import {
  computePhotoFeaturesFromRgba,
  normalizePhotoFingerprint,
  type PhotoFeatureKernelOutput,
} from "@/lib/photoFeatureKernel";
import type {
  PhotoFeatureWorkerRequest,
  PhotoFeatureWorkerResponse,
} from "@/workers/photoFeatureWorker";

const ANALYSIS_VERSION = 10;
const ANALYSIS_SIZE = 128;
// Keep more spatial detail than the thumbnail shown in the grid. A 24x24
// fingerprint is still cheap at 128px, but prevents different crops of the
// same artwork from collapsing into one view group.
const FINGERPRINT_SIZE = 24;
const HASH_SIZE = 16;
// A finer grid keeps the marker useful on small previews without decoding the
// full RAW. The analysis canvas is only 128px, so this remains inexpensive.
const FOCUS_GRID_SIZE = 8;
const MAX_FOCUS_REGIONS = 5;
// Keep one thumbnail slot free for visible grid/Quick Look requests while two
// background analysis tasks decode in parallel.
const MAX_CONCURRENT_ANALYSIS = 2;
const MAX_FEATURE_CACHE_ENTRIES = 4_000;
const MAX_FEATURE_CACHE_BYTES = 24 * 1024 * 1024;

const ANALYZABLE_EXTENSIONS = new Set(
  IMAGE_EXTENSIONS.filter((extension) => extension !== "svg" && extension !== "psd")
);

export type FocusAnalysisKind = "localized" | "multiple" | "full-frame" | "unavailable";
export type FocusAnalysisSource = "sharpness-estimate" | "unavailable";

export interface FocusRegion {
  /** Region bounds normalized from top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface FocusAnalysis {
  kind: FocusAnalysisKind;
  source: FocusAnalysisSource;
  regions: FocusRegion[];
  confidence: number;
}

export interface PhotoAnalysisRecord {
  path: string;
  imageWidth: number;
  imageHeight: number;
  fingerprint: Float32Array;
  hashBits: Uint8Array;
  edgeFingerprint: Float32Array;
  /** Thumbnail-derived sharp regions; unavailable when the image has no clear peak. */
  focusAnalysis: FocusAnalysis;
  groupId: number | null;
}

export type PhotoAnalysisStage =
  | "extracting-features"
  | "estimating-focus"
  | "grouping-views"
  | "done";

export interface PhotoAnalysisProgress {
  completed: number;
  total: number;
  isAnalyzing: boolean;
  stage: PhotoAnalysisStage;
  stageCompleted: number;
  stageTotal: number;
}

export interface PhotoAnalysisEntry {
  entry: FileEntry;
  key: string;
}

interface RawPhotoFeatures {
  path: string;
  imageWidth: number;
  imageHeight: number;
  fingerprint: Float32Array;
  hashBits: Uint8Array;
  edgeFingerprint: Float32Array;
  focusAnalysis: FocusAnalysis;
}

interface ExtractedPhotoFeatures {
  path: string;
  imageWidth: number;
  imageHeight: number;
  fingerprint: Float32Array;
  hashBits: Uint8Array;
  tileScores: Float32Array;
}

interface CachedAnalysis {
  features: ExtractedPhotoFeatures;
  bytes: number;
}

const featureCache = new Map<string, CachedAnalysis>();
let featureCacheBytes = 0;

function getFeatureBytes(features: ExtractedPhotoFeatures) {
  return (
    features.fingerprint.byteLength + features.hashBits.byteLength + features.tileScores.byteLength
  );
}

function getCachedFeatures(key: string) {
  const cached = featureCache.get(key);
  if (!cached) return null;
  featureCache.delete(key);
  featureCache.set(key, cached);
  return cached.features;
}

function cacheFeatures(key: string, features: ExtractedPhotoFeatures) {
  const previous = featureCache.get(key);
  if (previous) featureCacheBytes -= previous.bytes;
  featureCache.delete(key);
  const cached = { features, bytes: getFeatureBytes(features) };
  featureCache.set(key, cached);
  featureCacheBytes += cached.bytes;
  while (
    featureCache.size > MAX_FEATURE_CACHE_ENTRIES ||
    featureCacheBytes > MAX_FEATURE_CACHE_BYTES
  ) {
    const oldest = featureCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const evicted = featureCache.get(oldest);
    if (evicted) featureCacheBytes -= evicted.bytes;
    featureCache.delete(oldest);
  }
}

export function isAnalyzablePhoto(entry: FileEntry): boolean {
  return (
    !entry.is_dir &&
    ANALYZABLE_EXTENSIONS.has((entry.extension || "").toLowerCase()) &&
    !entry.name.startsWith("._")
  );
}

export function getPhotoAnalysisKey(entry: FileEntry): string {
  return `${entry.path}:${entry.modified ?? 0}:${entry.size}:${ANALYSIS_VERSION}`;
}

export function getPhotoAnalysisEntries(entries: FileEntry[]): PhotoAnalysisEntry[] {
  return entries
    .filter(isAnalyzablePhoto)
    .map((entry) => ({ entry, key: getPhotoAnalysisKey(entry) }));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function unavailableFocusAnalysis(): FocusAnalysis {
  return { kind: "unavailable", source: "sharpness-estimate", regions: [], confidence: 0 };
}

function smoothFocusTileScores(
  tileScores: Array<{ score: number; x: number; y: number }>
): Array<{ score: number; x: number; y: number }> {
  return tileScores.map((tile) => {
    let weightedScore = tile.score * 2;
    let totalWeight = 2;

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;

        const neighborX = tile.x + offsetX;
        const neighborY = tile.y + offsetY;
        if (
          neighborX < 0 ||
          neighborX >= FOCUS_GRID_SIZE ||
          neighborY < 0 ||
          neighborY >= FOCUS_GRID_SIZE
        ) {
          continue;
        }

        const neighbor = tileScores[neighborY * FOCUS_GRID_SIZE + neighborX];
        if (!neighbor) continue;

        // Direct neighbors describe the same physical sharp area more
        // reliably than diagonal neighbors. This suppresses one-pixel
        // contrast boundaries without erasing a small but connected subject.
        const weight = offsetX === 0 || offsetY === 0 ? 1.25 : 0.75;
        weightedScore += neighbor.score * weight;
        totalWeight += weight;
      }
    }

    return { ...tile, score: weightedScore / totalWeight };
  });
}

function buildFocusAnalysis(
  tileScores: Array<{ score: number; x: number; y: number }>
): FocusAnalysis {
  if (tileScores.length === 0) return unavailableFocusAnalysis();

  let sum = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const tile of tileScores) {
    sum += tile.score;
    minimum = Math.min(minimum, tile.score);
    maximum = Math.max(maximum, tile.score);
  }

  // A nearly flat thumbnail does not contain enough information for a useful
  // focus cue. Avoid drawing a confident box on blank or failed decodes.
  if (!Number.isFinite(minimum) || maximum < 2) return unavailableFocusAnalysis();

  const mean = sum / tileScores.length;
  let variance = 0;
  for (const tile of tileScores) {
    const delta = tile.score - mean;
    variance += delta * delta;
  }
  const deviation = Math.sqrt(variance / tileScores.length);
  const threshold = Math.min(
    maximum,
    Math.max(mean + deviation * 0.35, mean + (maximum - mean) * 0.36, maximum * 0.5)
  );

  const tileCount = FOCUS_GRID_SIZE * FOCUS_GRID_SIZE;
  const selected = new Array<boolean>(tileCount).fill(false);
  let selectedCount = 0;
  let strongestIndex = 0;
  tileScores.forEach((tile, index) => {
    if (tile.score > tileScores[strongestIndex].score) strongestIndex = index;
    if (tile.score >= threshold) {
      selected[index] = true;
      selectedCount += 1;
    }
  });
  if (selectedCount === 0) {
    selected[strongestIndex] = true;
    selectedCount = 1;
  }

  const visited = new Array<boolean>(tileCount).fill(false);
  const components: Array<number[]> = [];
  const directions = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  for (let index = 0; index < tileCount; index += 1) {
    if (!selected[index] || visited[index]) continue;
    const component: number[] = [];
    const queue = [index];
    visited[index] = true;

    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) continue;
      component.push(current);
      const currentX = current % FOCUS_GRID_SIZE;
      const currentY = Math.floor(current / FOCUS_GRID_SIZE);

      for (const [offsetX, offsetY] of directions) {
        const nextX = currentX + offsetX;
        const nextY = currentY + offsetY;
        if (nextX < 0 || nextX >= FOCUS_GRID_SIZE || nextY < 0 || nextY >= FOCUS_GRID_SIZE) {
          continue;
        }
        const next = nextY * FOCUS_GRID_SIZE + nextX;
        if (selected[next] && !visited[next]) {
          visited[next] = true;
          queue.push(next);
        }
      }
    }

    components.push(component);
  }

  const regions = components
    .map((component): FocusRegion => {
      let minX = FOCUS_GRID_SIZE;
      let minY = FOCUS_GRID_SIZE;
      let maxX = 0;
      let maxY = 0;
      let totalScore = 0;

      for (const index of component) {
        const tile = tileScores[index];
        minX = Math.min(minX, tile.x);
        minY = Math.min(minY, tile.y);
        maxX = Math.max(maxX, tile.x);
        maxY = Math.max(maxY, tile.y);
        totalScore += tile.score;
      }

      const componentMean = totalScore / Math.max(component.length, 1);
      const contrast = (componentMean - mean) / Math.max(maximum - mean, 1);
      const confidence = clamp(contrast * (0.65 + Math.min(component.length / 4, 1) * 0.35), 0, 1);

      return {
        x: minX / FOCUS_GRID_SIZE,
        y: minY / FOCUS_GRID_SIZE,
        width: (maxX - minX + 1) / FOCUS_GRID_SIZE,
        height: (maxY - minY + 1) / FOCUS_GRID_SIZE,
        confidence,
      };
    })
    .sort((first, second) => {
      const firstArea = first.width * first.height;
      const secondArea = second.width * second.height;
      return second.confidence - first.confidence || secondArea - firstArea;
    })
    .slice(0, MAX_FOCUS_REGIONS);

  const coverage = selectedCount / tileCount;
  // A broad, connected sharpness mask is more consistent with a focus-stack
  // composite than with one localized AF plane. It is intentionally labelled
  // “suspected” in the UI because the final image cannot prove its provenance.
  if (coverage >= 0.68 && maximum >= 4) {
    return {
      kind: "full-frame",
      source: "sharpness-estimate",
      regions: [],
      confidence: clamp(coverage * (mean / Math.max(maximum, 1)), 0, 1),
    };
  }

  if (regions.length === 0) return unavailableFocusAnalysis();
  return {
    kind: regions.length > 1 ? "multiple" : "localized",
    source: "sharpness-estimate",
    regions,
    confidence: regions[0].confidence,
  };
}

function createTileScoreGrid(tileScores: ArrayLike<number>) {
  return Array.from({ length: tileScores.length }, (_, index) => ({
    score: tileScores[index],
    x: index % FOCUS_GRID_SIZE,
    y: Math.floor(index / FOCUS_GRID_SIZE),
  }));
}

let sharedAnalysisCanvas: HTMLCanvasElement | null = null;
let sharedAnalysisContext: CanvasRenderingContext2D | null = null;

function getSharedAnalysisContext() {
  if (!sharedAnalysisCanvas) {
    sharedAnalysisCanvas = document.createElement("canvas");
    sharedAnalysisCanvas.width = ANALYSIS_SIZE;
    sharedAnalysisCanvas.height = ANALYSIS_SIZE;
    sharedAnalysisContext = sharedAnalysisCanvas.getContext("2d", { willReadFrequently: true });
  }
  return sharedAnalysisContext;
}

interface PendingFeatureJob {
  resolve: (result: PhotoFeatureKernelOutput) => void;
  reject: (error: unknown) => void;
}

let photoFeatureWorker: Worker | null = null;
let photoFeatureWorkerFailed = false;
let nextFeatureWorkerJobId = 1;
const pendingFeatureWorkerJobs = new Map<number, PendingFeatureJob>();

function getPhotoFeatureWorker(): Worker | null {
  if (photoFeatureWorkerFailed || typeof Worker === "undefined") return null;
  if (!photoFeatureWorker) {
    try {
      const worker = new Worker(new URL("../workers/photoFeatureWorker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<PhotoFeatureWorkerResponse>) => {
        const { id, fingerprintBuffer, hashBitsBuffer, tileScoresBuffer } = event.data;
        const job = pendingFeatureWorkerJobs.get(id);
        if (!job) return;
        pendingFeatureWorkerJobs.delete(id);
        job.resolve({
          fingerprint: new Float32Array(fingerprintBuffer),
          hashBits: new Uint8Array(hashBitsBuffer),
          tileScores: new Float32Array(tileScoresBuffer),
        });
      };
      worker.onerror = (error) => {
        photoFeatureWorkerFailed = true;
        photoFeatureWorker = null;
        for (const job of pendingFeatureWorkerJobs.values()) {
          job.reject(error);
        }
        pendingFeatureWorkerJobs.clear();
      };
      photoFeatureWorker = worker;
    } catch {
      photoFeatureWorkerFailed = true;
      return null;
    }
  }
  return photoFeatureWorker;
}

async function extractPhotoFeatures(
  image: HTMLImageElement,
  path: string
): Promise<ExtractedPhotoFeatures> {
  const context = getSharedAnalysisContext();
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  context.fillStyle = "#808080";
  context.fillRect(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);

  const scale = Math.min(ANALYSIS_SIZE / image.naturalWidth, ANALYSIS_SIZE / image.naturalHeight);
  const contentWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const contentHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const contentLeft = Math.floor((ANALYSIS_SIZE - contentWidth) / 2);
  const contentTop = Math.floor((ANALYSIS_SIZE - contentHeight) / 2);

  context.drawImage(image, contentLeft, contentTop, contentWidth, contentHeight);
  const imageData = context.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);

  const worker = getPhotoFeatureWorker();
  let kernelOutput: PhotoFeatureKernelOutput;
  if (worker) {
    const rgbaBuffer = imageData.data.buffer;
    const id = nextFeatureWorkerJobId++;
    try {
      kernelOutput = await new Promise<PhotoFeatureKernelOutput>((resolve, reject) => {
        pendingFeatureWorkerJobs.set(id, { resolve, reject });
        const request: PhotoFeatureWorkerRequest = {
          id,
          rgbaBuffer,
          analysisSize: ANALYSIS_SIZE,
          fingerprintSize: FINGERPRINT_SIZE,
          hashSize: HASH_SIZE,
          focusGridSize: FOCUS_GRID_SIZE,
          contentLeft,
          contentTop,
          contentWidth,
          contentHeight,
        };
        worker.postMessage(request, [rgbaBuffer]);
      });
    } catch {
      // Fallback to synchronous kernel if the worker terminated unexpectedly.
      const fallbackData = context.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
      kernelOutput = computePhotoFeaturesFromRgba({
        rgba: fallbackData.data,
        analysisSize: ANALYSIS_SIZE,
        fingerprintSize: FINGERPRINT_SIZE,
        hashSize: HASH_SIZE,
        focusGridSize: FOCUS_GRID_SIZE,
        contentLeft,
        contentTop,
        contentWidth,
        contentHeight,
      });
    }
  } else {
    kernelOutput = computePhotoFeaturesFromRgba({
      rgba: imageData.data,
      analysisSize: ANALYSIS_SIZE,
      fingerprintSize: FINGERPRINT_SIZE,
      hashSize: HASH_SIZE,
      focusGridSize: FOCUS_GRID_SIZE,
      contentLeft,
      contentTop,
      contentWidth,
      contentHeight,
    });
  }

  return {
    path,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    fingerprint: kernelOutput.fingerprint,
    hashBits: kernelOutput.hashBits,
    tileScores: kernelOutput.tileScores,
  };
}

function finalizePhotoFeatures(features: ExtractedPhotoFeatures): RawPhotoFeatures {
  const tileScoreGrid = createTileScoreGrid(features.tileScores);
  return {
    path: features.path,
    imageWidth: features.imageWidth,
    imageHeight: features.imageHeight,
    fingerprint: features.fingerprint,
    hashBits: features.hashBits,
    edgeFingerprint: normalizePhotoFingerprint(features.tileScores),
    focusAnalysis: buildFocusAnalysis(smoothFocusTileScores(tileScoreGrid)),
  };
}

async function analyzeEntry(entry: FileEntry, key: string, signal: AbortSignal) {
  const cached = getCachedFeatures(key);
  if (cached) return cached;

  if (signal.aborted) return null;
  const availableThumbnail = getLargestLoadedFileThumbnailUrl(
    entry.path,
    entry.modified,
    entry.size
  );
  // Share the visible grid thumbnail URL whenever possible so WKWebView's
  // native cache and Rust's binary LRU serve the same bytes with zero Base64.
  const thumbnailRequestSize = getThumbnailRequestSize(80);
  const url =
    availableThumbnail?.url ??
    buildFileThumbnailUrl(
      entry.path,
      entry.modified,
      entry.size,
      thumbnailRequestSize,
      true,
      false,
      true
    );

  let image: HTMLImageElement;
  try {
    image = await loadHtmlImage(url, signal);
  } catch {
    return null;
  }
  if (signal.aborted) return null;
  const features = await extractPhotoFeatures(image, entry.path);
  if (signal.aborted) return null;
  cacheFeatures(key, features);
  return features;
}

const FINGERPRINT_LENGTH = FINGERPRINT_SIZE * FINGERPRINT_SIZE;
const HASH_BITS_LENGTH = HASH_SIZE * HASH_SIZE;
const TILE_SCORES_LENGTH = FOCUS_GRID_SIZE * FOCUS_GRID_SIZE;
const FINGERPRINT_BYTES = FINGERPRINT_LENGTH * Float32Array.BYTES_PER_ELEMENT;
const TILE_SCORES_BYTES = TILE_SCORES_LENGTH * Float32Array.BYTES_PER_ELEMENT;
const EXPECTED_FEATURE_BLOB_BYTES = FINGERPRINT_BYTES + HASH_BITS_LENGTH + TILE_SCORES_BYTES;
const SQLITE_PERSIST_BATCH_SIZE = 24;

interface PersistedPhotoFeatureRecord {
  path: string;
  modified: number;
  fileSize: number;
  imageWidth: number;
  imageHeight: number;
  featuresBase64: string;
}

export function encodePhotoFeaturesToBase64(features: {
  fingerprint: Float32Array;
  hashBits: Uint8Array;
  tileScores: Float32Array;
}): string {
  const bytes = new Uint8Array(EXPECTED_FEATURE_BLOB_BYTES);
  bytes.set(
    new Uint8Array(features.fingerprint.buffer, features.fingerprint.byteOffset, FINGERPRINT_BYTES),
    0
  );
  bytes.set(features.hashBits.subarray(0, HASH_BITS_LENGTH), FINGERPRINT_BYTES);
  bytes.set(
    new Uint8Array(features.tileScores.buffer, features.tileScores.byteOffset, TILE_SCORES_BYTES),
    FINGERPRINT_BYTES + HASH_BITS_LENGTH
  );

  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodePhotoFeaturesFromBase64(
  path: string,
  imageWidth: number,
  imageHeight: number,
  featuresBase64: string
): ExtractedPhotoFeatures | null {
  try {
    const binary = atob(featuresBase64);
    if (binary.length !== EXPECTED_FEATURE_BLOB_BYTES) return null;
    const buffer = new ArrayBuffer(EXPECTED_FEATURE_BLOB_BYTES);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const fingerprint = new Float32Array(buffer.slice(0, FINGERPRINT_BYTES));
    const hashBits = new Uint8Array(
      buffer.slice(FINGERPRINT_BYTES, FINGERPRINT_BYTES + HASH_BITS_LENGTH)
    );
    const tileScores = new Float32Array(
      buffer.slice(FINGERPRINT_BYTES + HASH_BITS_LENGTH, EXPECTED_FEATURE_BLOB_BYTES)
    );
    return { path, imageWidth, imageHeight, fingerprint, hashBits, tileScores };
  } catch {
    return null;
  }
}

async function hydrateFeaturesFromSqlite(
  entries: PhotoAnalysisEntry[],
  signal: AbortSignal
): Promise<Map<string, ExtractedPhotoFeatures>> {
  const hydrated = new Map<string, ExtractedPhotoFeatures>();
  const missingEntries: PhotoAnalysisEntry[] = [];
  for (const item of entries) {
    const inMemory = getCachedFeatures(item.key);
    if (inMemory) {
      hydrated.set(item.entry.path, inMemory);
    } else {
      missingEntries.push(item);
    }
  }
  if (missingEntries.length === 0 || signal.aborted) return hydrated;

  try {
    const rows = await invoke<PersistedPhotoFeatureRecord[]>("get_cached_photo_features", {
      items: missingEntries.map(({ entry }) => ({
        path: entry.path,
        modified: entry.modified ?? 0,
        fileSize: entry.size,
      })),
      analysisVersion: ANALYSIS_VERSION,
    });
    if (signal.aborted) return hydrated;

    const keyByPath = new Map(missingEntries.map((item) => [item.entry.path, item.key]));
    for (const row of rows) {
      const key = keyByPath.get(row.path);
      if (!key) continue;
      const decoded = decodePhotoFeaturesFromBase64(
        row.path,
        row.imageWidth,
        row.imageHeight,
        row.featuresBase64
      );
      if (!decoded) continue;
      cacheFeatures(key, decoded);
      hydrated.set(row.path, decoded);
    }
  } catch {
    // SQLite cache is best-effort; fall back to normal decoding if unavailable.
  }

  return hydrated;
}

function persistFeaturesToSqlite(records: PersistedPhotoFeatureRecord[]) {
  if (records.length === 0) return;
  void invoke("save_cached_photo_features", {
    records,
    analysisVersion: ANALYSIS_VERSION,
  }).catch(() => undefined);
}

export async function analyzePhotoEntries(
  entries: PhotoAnalysisEntry[],
  signal: AbortSignal,
  onUpdate: (progress: PhotoAnalysisProgress, records: Map<string, PhotoAnalysisRecord>) => void,
  getPriorityPaths?: () => string[]
): Promise<Map<string, PhotoAnalysisRecord>> {
  const finalizedByPath = new Map<string, RawPhotoFeatures>();
  const unpublishedFeatures = new Map<string, RawPhotoFeatures>();
  const pendingPersist: PersistedPhotoFeatureRecord[] = [];
  let extractedCompleted = 0;

  // Hydrate previously computed features from memory + SQLite in one batch
  // before decoding any thumbnails so revisits to large folders finish in ms.
  const hydrated = await hydrateFeaturesFromSqlite(entries, signal);
  if (signal.aborted) return new Map();

  const remainingEntries: PhotoAnalysisEntry[] = [];
  for (const item of entries) {
    const cached = hydrated.get(item.entry.path);
    if (cached) {
      const finalized = finalizePhotoFeatures(cached);
      finalizedByPath.set(item.entry.path, finalized);
      unpublishedFeatures.set(item.entry.path, finalized);
      extractedCompleted += 1;
    } else {
      remainingEntries.push(item);
    }
  }

  if (unpublishedFeatures.size > 0 && remainingEntries.length > 0) {
    const partialRecords = new Map<string, PhotoAnalysisRecord>();
    for (const features of unpublishedFeatures.values()) {
      partialRecords.set(features.path, { ...features, groupId: null });
    }
    unpublishedFeatures.clear();
    onUpdate(
      {
        completed: extractedCompleted,
        total: entries.length,
        isAnalyzing: true,
        stage: "extracting-features",
        stageCompleted: extractedCompleted,
        stageTotal: entries.length,
      },
      partialRecords
    );
  }

  const pendingByPath = new Map(remainingEntries.map((item) => [item.entry.path, item]));
  let nextIndex = 0;
  let lastProgressEmitAt = performance.now();
  let itemsSinceProgressEmit = 0;
  const PROGRESS_EMIT_INTERVAL_MS = 180;
  const PROGRESS_EMIT_MAX_ITEMS = 8;

  const worker = async () => {
    let lastBrowserYieldAt = performance.now();
    while (!signal.aborted) {
      let item: PhotoAnalysisEntry | undefined;
      for (const path of getPriorityPaths?.() ?? []) {
        item = pendingByPath.get(path);
        if (item) break;
      }
      while (!item && nextIndex < remainingEntries.length) {
        const candidate = remainingEntries[nextIndex++];
        item = pendingByPath.get(candidate.entry.path);
      }
      if (!item) return;
      pendingByPath.delete(item.entry.path);
      try {
        const features = await analyzeEntry(item.entry, item.key, signal);
        if (features) {
          const finalized = finalizePhotoFeatures(features);
          finalizedByPath.set(item.entry.path, finalized);
          unpublishedFeatures.set(item.entry.path, finalized);
          pendingPersist.push({
            path: item.entry.path,
            modified: item.entry.modified ?? 0,
            fileSize: item.entry.size,
            imageWidth: features.imageWidth,
            imageHeight: features.imageHeight,
            featuresBase64: encodePhotoFeaturesToBase64(features),
          });
          if (pendingPersist.length >= SQLITE_PERSIST_BATCH_SIZE) {
            persistFeaturesToSqlite(pendingPersist.splice(0, pendingPersist.length));
          }
        }
      } catch (error) {
        console.warn(`Failed to analyze photo: ${item.entry.path}`, error);
      } finally {
        extractedCompleted += 1;
        itemsSinceProgressEmit += 1;
        const now = performance.now();
        if (
          extractedCompleted === 1 ||
          itemsSinceProgressEmit >= PROGRESS_EMIT_MAX_ITEMS ||
          now - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS ||
          extractedCompleted === entries.length
        ) {
          lastProgressEmitAt = now;
          itemsSinceProgressEmit = 0;
          const partialRecords = new Map<string, PhotoAnalysisRecord>();
          for (const features of unpublishedFeatures.values()) {
            partialRecords.set(features.path, { ...features, groupId: null });
          }
          unpublishedFeatures.clear();
          onUpdate(
            {
              completed: extractedCompleted,
              total: entries.length,
              isAnalyzing: true,
              stage: "extracting-features",
              stageCompleted: extractedCompleted,
              stageTotal: entries.length,
            },
            partialRecords
          );
        }
        if (performance.now() - lastBrowserYieldAt >= 12) {
          await yieldToBrowser();
          lastBrowserYieldAt = performance.now();
        }
      }
    }
  };

  if (remainingEntries.length > 0) {
    const workerCount = Math.min(MAX_CONCURRENT_ANALYSIS, remainingEntries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  if (pendingPersist.length > 0) {
    persistFeaturesToSqlite(pendingPersist.splice(0, pendingPersist.length));
  }

  if (signal.aborted) return new Map();

  // Focus regions were finalized as each thumbnail arrived. Publish the stage
  // once instead of replaying every record and rerendering the grid repeatedly.
  onUpdate(
    {
      completed: entries.length,
      total: entries.length,
      isAnalyzing: true,
      stage: "estimating-focus",
      stageCompleted: entries.length,
      stageTotal: entries.length,
    },
    new Map()
  );

  if (signal.aborted) return new Map();
  onUpdate(
    {
      completed: entries.length,
      total: entries.length,
      isAnalyzing: true,
      stage: "grouping-views",
      stageCompleted: 0,
      stageTotal: 1,
    },
    new Map()
  );
  await yieldToBrowser();

  const finalRecords = createPhotoAnalysisRecords(entries, finalizedByPath);
  onUpdate(
    {
      completed: entries.length,
      total: entries.length,
      isAnalyzing: true,
      stage: "grouping-views",
      stageCompleted: 1,
      stageTotal: 1,
    },
    finalRecords
  );
  return finalRecords;
}

function createPhotoAnalysisRecords(
  entries: PhotoAnalysisEntry[],
  featuresByPath: Map<string, RawPhotoFeatures>,
  includeGroups = true
): Map<string, PhotoAnalysisRecord> {
  const featuresInFolderOrder: RawPhotoFeatures[] = [];
  for (const item of entries) {
    const features = featuresByPath.get(item.entry.path);
    if (features) featuresInFolderOrder.push(features);
  }
  const groups = includeGroups
    ? groupPhotoFeatures(featuresInFolderOrder)
    : new Map<string, number | null>();
  const result = new Map<string, PhotoAnalysisRecord>();
  for (const features of featuresInFolderOrder) {
    result.set(features.path, {
      ...features,
      groupId: groups.get(features.path) ?? null,
    });
  }
  return result;
}

export function getPhotoGroupColor(groupId: number | null): string | undefined {
  if (groupId === null) return undefined;
  return `hsl(var(--photo-group-${(groupId % 6) + 1}))`;
}
