import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import type { FileEntry } from "@/types";
import {
  getFileThumbnailCacheKey,
  getThumbnailRequestSize,
  loadFileThumbnail,
} from "@/lib/iconCache";

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
  fingerprint: number[];
  hashBits: number[];
  edgeFingerprint: number[];
  /** Thumbnail-derived sharp regions; unavailable when the image has no clear peak. */
  focusAnalysis: FocusAnalysis;
  groupId: number | null;
}

export interface PhotoAnalysisProgress {
  completed: number;
  total: number;
  isAnalyzing: boolean;
}

export interface PhotoAnalysisEntry {
  entry: FileEntry;
  key: string;
}

interface RawPhotoFeatures {
  path: string;
  imageWidth: number;
  imageHeight: number;
  fingerprint: number[];
  hashBits: number[];
  edgeFingerprint: number[];
  focusAnalysis: FocusAnalysis;
}

interface CachedAnalysis {
  key: string;
  features: RawPhotoFeatures;
}

const featureCache = new Map<string, CachedAnalysis>();

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

function decodeThumbnail(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode analysis thumbnail"));
    image.src = `data:image/png;base64,${base64}`;
  });
}

function getGray(imageData: ImageData, x: number, y: number) {
  const index = (y * imageData.width + x) * 4;
  return (
    imageData.data[index] * 0.2126 +
    imageData.data[index + 1] * 0.7152 +
    imageData.data[index + 2] * 0.0722
  );
}

function normalizeFingerprint(values: number[]) {
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / Math.max(1, values.length);

  let variance = 0;
  for (const value of values) {
    const delta = value - mean;
    variance += delta * delta;
  }
  const deviation = Math.sqrt(variance / Math.max(1, values.length)) || 1;
  return values.map((value) => clamp((value - mean) / deviation, -3, 3) / 3);
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

function createFeatures(image: HTMLImageElement, path: string): RawPhotoFeatures {
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

  const fingerprintValues: number[] = [];
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
      fingerprintValues.push(getGray(imageData, sampleX, sampleY));
    }
  }

  const hashBits: number[] = [];
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
      hashBits.push(
        getGray(imageData, leftX, sampleY) < getGray(imageData, rightX, sampleY) ? 1 : 0
      );
    }
  }

  // Camera-maker AF regions are not consistently exposed by Quick Look, so
  // the first pass uses multi-scale local detail to estimate sharp regions.
  const tileWidth = Math.max(8, Math.floor(contentWidth / FOCUS_GRID_SIZE));
  const tileHeight = Math.max(8, Math.floor(contentHeight / FOCUS_GRID_SIZE));
  const tileScores: Array<{ score: number; x: number; y: number }> = [];

  for (let tileY = 0; tileY < FOCUS_GRID_SIZE; tileY += 1) {
    for (let tileX = 0; tileX < FOCUS_GRID_SIZE; tileX += 1) {
      const startX = contentLeft + tileX * tileWidth;
      const startY = contentTop + tileY * tileHeight;
      const endX = Math.min(contentLeft + contentWidth - 1, startX + tileWidth);
      const endY = Math.min(contentTop + contentHeight - 1, startY + tileHeight);
      const gradientValues: number[] = [];
      const laplacianValues: number[] = [];
      let horizontalEnergy = 0;
      let verticalEnergy = 0;
      let samples = 0;

      for (let y = startY + 1; y < endY - 1; y += 1) {
        for (let x = startX + 1; x < endX - 1; x += 1) {
          const center = getGray(imageData, x, y);
          const horizontal = Math.abs(getGray(imageData, x + 1, y) - getGray(imageData, x - 1, y));
          const vertical = Math.abs(getGray(imageData, x, y + 1) - getGray(imageData, x, y - 1));
          const gradient = (horizontal + vertical) / 2;
          horizontalEnergy += horizontal;
          verticalEnergy += vertical;
          const laplacian = Math.abs(
            center * 4 -
              getGray(imageData, x - 1, y) -
              getGray(imageData, x + 1, y) -
              getGray(imageData, x, y - 1) -
              getGray(imageData, x, y + 1)
          );
          gradientValues.push(gradient);
          laplacianValues.push(laplacian);
          samples += 1;
        }
      }

      const gradientMean =
        gradientValues.reduce((total, value) => total + value, 0) / Math.max(samples, 1);
      const laplacianMean =
        laplacianValues.reduce((total, value) => total + value, 0) / Math.max(samples, 1);
      const gradientDeviation = Math.sqrt(
        gradientValues.reduce((total, value) => total + (value - gradientMean) ** 2, 0) /
          Math.max(samples, 1)
      );
      const laplacianDeviation = Math.sqrt(
        laplacianValues.reduce((total, value) => total + (value - laplacianMean) ** 2, 0) /
          Math.max(samples, 1)
      );
      const gradientSpread =
        gradientValues.filter(
          (value) => value >= Math.max(2, gradientMean + gradientDeviation * 0.35)
        ).length / Math.max(samples, 1);
      const laplacianSpread =
        laplacianValues.filter(
          (value) => value >= Math.max(2, laplacianMean + laplacianDeviation * 0.35)
        ).length / Math.max(samples, 1);
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

      tileScores.push({
        score: samples > 0 ? score : 0,
        x: tileX,
        y: tileY,
      });
    }
  }

  const edgeFingerprint = normalizeFingerprint(tileScores.map((tile) => tile.score));
  const focusAnalysis = buildFocusAnalysis(smoothFocusTileScores(tileScores));

  return {
    path,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    fingerprint: normalizeFingerprint(fingerprintValues),
    hashBits,
    edgeFingerprint,
    focusAnalysis,
  };
}

async function analyzeEntry(entry: FileEntry, key: string, signal: AbortSignal) {
  const cached = featureCache.get(key);
  if (cached) return cached.features;

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
  const features = createFeatures(image, entry.path);
  featureCache.set(key, { key, features });
  return features;
}

function fingerprintDistance(first: number[], second: number[]) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return 1;
  let distance = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = first[index] - second[index];
    distance += delta * delta;
  }
  return Math.sqrt(distance / length);
}

function hashDistance(first: number[], second: number[]) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return 1;
  let different = 0;
  for (let index = 0; index < length; index += 1) {
    if (first[index] !== second[index]) different += 1;
  }
  return different / length;
}

function isSameView(first: RawPhotoFeatures, second: RawPhotoFeatures) {
  const firstAspect = first.imageWidth / Math.max(first.imageHeight, 1);
  const secondAspect = second.imageWidth / Math.max(second.imageHeight, 1);
  if (Math.abs(Math.log(firstAspect / secondAspect)) > 0.08) return false;

  const visualDistance = fingerprintDistance(first.fingerprint, second.fingerprint);
  const hashDistanceValue = hashDistance(first.hashBits, second.hashBits);
  const edgeDistance = fingerprintDistance(first.edgeFingerprint, second.edgeFingerprint);

  // Require all three signals. The old visual-only fallback was too permissive
  // for different crops of the same artwork: grayscale tone could match even
  // when the composition and edge layout had changed substantially.
  return visualDistance <= 0.42 && hashDistanceValue <= 0.16 && edgeDistance <= 0.38;
}

function buildGroups(
  entries: PhotoAnalysisEntry[],
  featuresByPath: Map<string, RawPhotoFeatures>
): Map<string, number | null> {
  const groups = new Map<string, number | null>();
  const candidates: Array<{
    representative: RawPhotoFeatures;
    members: PhotoAnalysisEntry[];
    memberFeatures: RawPhotoFeatures[];
  }> = [];

  for (const item of entries) {
    const features = featuresByPath.get(item.entry.path);
    if (!features) {
      continue;
    }

    const matchingGroup = candidates.find(
      (candidate) =>
        isSameView(candidate.representative, features) &&
        candidate.memberFeatures.every((member) => isSameView(member, features))
    );
    if (matchingGroup) {
      matchingGroup.members.push(item);
      matchingGroup.memberFeatures.push(features);
    } else {
      candidates.push({ representative: features, members: [item], memberFeatures: [features] });
    }
  }

  // A view can reappear later in a folder, so groups are global rather than
  // limited to adjacent filenames. IDs still follow the first file's order.
  candidates.forEach((candidate, groupId) => {
    if (candidate.members.length < 2) return;
    for (const member of candidate.members) {
      groups.set(member.entry.path, groupId);
    }
  });

  return groups;
}

export async function analyzePhotoEntries(
  entries: PhotoAnalysisEntry[],
  signal: AbortSignal,
  onUpdate: (completed: number, records: Map<string, PhotoAnalysisRecord>) => void
): Promise<Map<string, PhotoAnalysisRecord>> {
  const featuresByPath = new Map<string, RawPhotoFeatures>();
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const item = entries[index];
      try {
        const features = await analyzeEntry(item.entry, item.key, signal);
        if (features) featuresByPath.set(item.entry.path, features);
      } catch (error) {
        console.warn(`Failed to analyze photo: ${item.entry.path}`, error);
      } finally {
        completed += 1;
        if (completed === 1 || completed % 4 === 0 || completed === entries.length) {
          // Grouping is quadratic in the worst case. Keep partial updates
          // focused on decoded thumbnails/regions and do the final grouping
          // once the whole folder has been analyzed.
          onUpdate(completed, createPhotoAnalysisRecords(entries, featuresByPath, false));
        }
        await yieldToBrowser();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_ANALYSIS, entries.length) }, () => worker())
  );

  if (signal.aborted) return new Map();
  return createPhotoAnalysisRecords(entries, featuresByPath);
}

function createPhotoAnalysisRecords(
  entries: PhotoAnalysisEntry[],
  featuresByPath: Map<string, RawPhotoFeatures>,
  includeGroups = true
): Map<string, PhotoAnalysisRecord> {
  const groups = includeGroups
    ? buildGroups(entries, featuresByPath)
    : new Map<string, number | null>();
  const result = new Map<string, PhotoAnalysisRecord>();
  for (const item of entries) {
    const features = featuresByPath.get(item.entry.path);
    if (!features) continue;
    result.set(item.entry.path, {
      ...features,
      groupId: groups.get(item.entry.path) ?? null,
    });
  }
  return result;
}

export function getPhotoGroupColor(groupId: number | null): string | undefined {
  if (groupId === null) return undefined;
  return `hsl(var(--photo-group-${(groupId % 6) + 1}))`;
}
