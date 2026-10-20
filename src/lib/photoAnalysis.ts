import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import type { FileEntry } from "@/types";
import {
  getFileThumbnailCacheKey,
  getThumbnailRequestSize,
  loadFileThumbnail,
} from "@/lib/iconCache";
import { groupPhotoFeatures } from "@/lib/photoGrouping";

const ANALYSIS_VERSION = 8;
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

function getProgressBatchSize(total: number, minimum: number) {
  return Math.max(minimum, Math.ceil(total / 40));
}

function decodeThumbnail(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode analysis thumbnail"));
    image.src = `data:image/png;base64,${base64}`;
  });
}

function normalizeFingerprint(values: ArrayLike<number>) {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) sum += values[index];
  const mean = sum / Math.max(1, values.length);

  let variance = 0;
  for (let index = 0; index < values.length; index += 1) {
    const delta = values[index] - mean;
    variance += delta * delta;
  }
  const deviation = Math.sqrt(variance / Math.max(1, values.length)) || 1;
  const normalized = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = clamp((values[index] - mean) / deviation, -3, 3) / 3;
  }
  return normalized;
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

function extractPhotoFeatures(image: HTMLImageElement, path: string): ExtractedPhotoFeatures {
  const canvas = document.createElement("canvas");
  canvas.width = ANALYSIS_SIZE;
  canvas.height = ANALYSIS_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
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
  const rgba = imageData.data;
  const grayscale = new Float32Array(ANALYSIS_SIZE * ANALYSIS_SIZE);
  for (let pixelIndex = 0; pixelIndex < grayscale.length; pixelIndex += 1) {
    const rgbaIndex = pixelIndex * 4;
    grayscale[pixelIndex] =
      rgba[rgbaIndex] * 0.2126 + rgba[rgbaIndex + 1] * 0.7152 + rgba[rgbaIndex + 2] * 0.0722;
  }

  const fingerprintValues = new Float32Array(FINGERPRINT_SIZE * FINGERPRINT_SIZE);
  for (let row = 0; row < FINGERPRINT_SIZE; row += 1) {
    for (let column = 0; column < FINGERPRINT_SIZE; column += 1) {
      const sampleX = clamp(
        Math.floor(contentLeft + ((column + 0.5) * contentWidth) / FINGERPRINT_SIZE),
        0,
        ANALYSIS_SIZE - 1
      );
      const sampleY = clamp(
        Math.floor(contentTop + ((row + 0.5) * contentHeight) / FINGERPRINT_SIZE),
        0,
        ANALYSIS_SIZE - 1
      );
      fingerprintValues[row * FINGERPRINT_SIZE + column] =
        grayscale[sampleY * ANALYSIS_SIZE + sampleX];
    }
  }

  const hashBits = new Uint8Array(HASH_SIZE * HASH_SIZE);
  for (let row = 0; row < HASH_SIZE; row += 1) {
    for (let column = 0; column < HASH_SIZE; column += 1) {
      const leftX = clamp(
        Math.floor(contentLeft + ((column + 0.25) * contentWidth) / HASH_SIZE),
        0,
        ANALYSIS_SIZE - 1
      );
      const rightX = clamp(
        Math.floor(contentLeft + ((column + 1.25) * contentWidth) / HASH_SIZE),
        0,
        ANALYSIS_SIZE - 1
      );
      const sampleY = clamp(
        Math.floor(contentTop + ((row + 0.5) * contentHeight) / HASH_SIZE),
        0,
        ANALYSIS_SIZE - 1
      );
      hashBits[row * HASH_SIZE + column] =
        grayscale[sampleY * ANALYSIS_SIZE + leftX] < grayscale[sampleY * ANALYSIS_SIZE + rightX]
          ? 1
          : 0;
    }
  }

  // Camera-maker AF regions are not consistently exposed by Quick Look, so
  // the first pass uses multi-scale local detail to estimate sharp regions.
  const tileWidth = Math.max(8, Math.floor(contentWidth / FOCUS_GRID_SIZE));
  const tileHeight = Math.max(8, Math.floor(contentHeight / FOCUS_GRID_SIZE));
  const tileScores = new Float32Array(FOCUS_GRID_SIZE * FOCUS_GRID_SIZE);
  const maximumTileSamples = Math.max(1, (tileWidth - 2) * (tileHeight - 2));
  const gradientValues = new Float32Array(maximumTileSamples);
  const laplacianValues = new Float32Array(maximumTileSamples);

  for (let tileY = 0; tileY < FOCUS_GRID_SIZE; tileY += 1) {
    for (let tileX = 0; tileX < FOCUS_GRID_SIZE; tileX += 1) {
      const startX = contentLeft + tileX * tileWidth;
      const startY = contentTop + tileY * tileHeight;
      const endX = Math.min(contentLeft + contentWidth - 1, startX + tileWidth);
      const endY = Math.min(contentTop + contentHeight - 1, startY + tileHeight);
      let gradientSum = 0;
      let laplacianSum = 0;
      let horizontalEnergy = 0;
      let verticalEnergy = 0;
      let samples = 0;

      for (let y = startY + 1; y < endY - 1; y += 1) {
        for (let x = startX + 1; x < endX - 1; x += 1) {
          const pixelIndex = y * ANALYSIS_SIZE + x;
          const center = grayscale[pixelIndex];
          const horizontal = Math.abs(grayscale[pixelIndex + 1] - grayscale[pixelIndex - 1]);
          const vertical = Math.abs(
            grayscale[pixelIndex + ANALYSIS_SIZE] - grayscale[pixelIndex - ANALYSIS_SIZE]
          );
          const gradient = (horizontal + vertical) / 2;
          horizontalEnergy += horizontal;
          verticalEnergy += vertical;
          const laplacian = Math.abs(
            center * 4 -
              grayscale[pixelIndex - 1] -
              grayscale[pixelIndex + 1] -
              grayscale[pixelIndex - ANALYSIS_SIZE] -
              grayscale[pixelIndex + ANALYSIS_SIZE]
          );
          gradientValues[samples] = gradient;
          laplacianValues[samples] = laplacian;
          gradientSum += gradient;
          laplacianSum += laplacian;
          samples += 1;
        }
      }

      const sampleCount = Math.max(samples, 1);
      const gradientMean = gradientSum / sampleCount;
      const laplacianMean = laplacianSum / sampleCount;
      let gradientVariance = 0;
      let laplacianVariance = 0;
      for (let index = 0; index < samples; index += 1) {
        gradientVariance += (gradientValues[index] - gradientMean) ** 2;
        laplacianVariance += (laplacianValues[index] - laplacianMean) ** 2;
      }
      const gradientDeviation = Math.sqrt(gradientVariance / sampleCount);
      const laplacianDeviation = Math.sqrt(laplacianVariance / sampleCount);
      const gradientThreshold = Math.max(2, gradientMean + gradientDeviation * 0.35);
      const laplacianThreshold = Math.max(2, laplacianMean + laplacianDeviation * 0.35);
      let gradientSpreadCount = 0;
      let laplacianSpreadCount = 0;
      for (let index = 0; index < samples; index += 1) {
        if (gradientValues[index] >= gradientThreshold) gradientSpreadCount += 1;
        if (laplacianValues[index] >= laplacianThreshold) laplacianSpreadCount += 1;
      }
      const gradientSpread = gradientSpreadCount / sampleCount;
      const laplacianSpread = laplacianSpreadCount / sampleCount;
      const textureSpread = (gradientSpread + laplacianSpread) / 2;
      const directionBalance =
        1 -
        Math.abs(horizontalEnergy - verticalEnergy) /
          Math.max(horizontalEnergy + verticalEnergy, 1);
      // A single high-contrast border can have a larger raw gradient than a
      // genuinely textured subject. Combine first- and second-order detail,
      // then discount energy concentrated in only a few pixels or one dominant
      // edge direction (for example, a display-case boundary).
      const detailScore = gradientMean * 0.45 + laplacianMean * 0.55;
      const textureFactor = 0.45 + Math.min(textureSpread * 1.85, 0.55);
      const directionFactor = 0.4 + directionBalance * 0.6;
      const score = detailScore * textureFactor * directionFactor;

      tileScores[tileY * FOCUS_GRID_SIZE + tileX] = samples > 0 ? score : 0;
    }
  }

  return {
    path,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    fingerprint: normalizeFingerprint(fingerprintValues),
    hashBits,
    tileScores,
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
    edgeFingerprint: normalizeFingerprint(features.tileScores),
    focusAnalysis: buildFocusAnalysis(smoothFocusTileScores(tileScoreGrid)),
  };
}

async function analyzeEntry(entry: FileEntry, key: string, signal: AbortSignal) {
  const cached = getCachedFeatures(key);
  if (cached) return cached;

  if (signal.aborted) return null;
  // Share the visible 80px grid thumbnail whenever possible. The image is
  // still sampled into the smaller analysis canvas, but RAW decoding happens
  // only once per file/request size.
  const thumbnailRequestSize = getThumbnailRequestSize(80);
  const thumbnailKey = getFileThumbnailCacheKey(
    entry.path,
    entry.modified,
    entry.size,
    thumbnailRequestSize,
    true
  );
  // Do not accept the generic ARW document icon as an analysis image. It has
  // the same pixels for every failed RAW decode and would create false groups.
  const base64 = await loadFileThumbnail(
    thumbnailKey,
    entry.path,
    thumbnailRequestSize,
    false,
    signal,
    "background",
    true
  );
  if (!base64 || signal.aborted) return null;

  const image = await decodeThumbnail(base64);
  if (signal.aborted) return null;
  const features = extractPhotoFeatures(image, entry.path);
  cacheFeatures(key, features);
  return features;
}

export async function analyzePhotoEntries(
  entries: PhotoAnalysisEntry[],
  signal: AbortSignal,
  onUpdate: (progress: PhotoAnalysisProgress, records: Map<string, PhotoAnalysisRecord>) => void
): Promise<Map<string, PhotoAnalysisRecord>> {
  const extractedByPath = new Map<string, ExtractedPhotoFeatures>();
  const finalizedByPath = new Map<string, RawPhotoFeatures>();
  let nextIndex = 0;
  let extractedCompleted = 0;
  const extractionProgressBatch = getProgressBatchSize(entries.length, 12);

  const worker = async () => {
    let lastBrowserYieldAt = performance.now();
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const item = entries[index];
      try {
        const features = await analyzeEntry(item.entry, item.key, signal);
        if (features) extractedByPath.set(item.entry.path, features);
      } catch (error) {
        console.warn(`Failed to analyze photo: ${item.entry.path}`, error);
      } finally {
        extractedCompleted += 1;
        if (
          extractedCompleted === 1 ||
          extractedCompleted % extractionProgressBatch === 0 ||
          extractedCompleted === entries.length
        ) {
          onUpdate(
            {
              completed: extractedCompleted,
              total: entries.length,
              isAnalyzing: true,
              stage: "extracting-features",
              stageCompleted: extractedCompleted,
              stageTotal: entries.length,
            },
            new Map()
          );
        }
        if (performance.now() - lastBrowserYieldAt >= 12) {
          await yieldToBrowser();
          lastBrowserYieldAt = performance.now();
        }
      }
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_ANALYSIS, entries.length);

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (signal.aborted) return new Map();

  let focusCompleted = 0;
  const focusProgressBatch = getProgressBatchSize(entries.length, 16);
  let focusBatchEntries: PhotoAnalysisEntry[] = [];
  let focusLastBrowserYieldAt = performance.now();
  for (const item of entries) {
    if (signal.aborted) return new Map();
    const extracted = extractedByPath.get(item.entry.path);
    if (extracted) {
      finalizedByPath.set(item.entry.path, finalizePhotoFeatures(extracted));
      focusBatchEntries.push(item);
    }
    focusCompleted += 1;
    if (
      focusCompleted === 1 ||
      focusCompleted % focusProgressBatch === 0 ||
      focusCompleted === entries.length
    ) {
      const partialRecords = createPhotoAnalysisRecords(focusBatchEntries, finalizedByPath, false);
      focusBatchEntries = [];
      onUpdate(
        {
          completed: entries.length,
          total: entries.length,
          isAnalyzing: true,
          stage: "estimating-focus",
          stageCompleted: focusCompleted,
          stageTotal: entries.length,
        },
        partialRecords
      );
    }
    if (performance.now() - focusLastBrowserYieldAt >= 12) {
      await yieldToBrowser();
      focusLastBrowserYieldAt = performance.now();
    }
  }

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
    createPhotoAnalysisRecords(entries, finalizedByPath, false)
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
