import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import type { FileEntry } from "@/types";
import { loadFileThumbnail } from "@/lib/iconCache";

const ANALYSIS_VERSION = 1;
const ANALYSIS_SIZE = 128;
const FINGERPRINT_SIZE = 16;
// A finer grid keeps the marker useful on small previews without decoding the
// full RAW. The analysis canvas is only 128px, so this remains inexpensive.
const FOCUS_GRID_SIZE = 8;
const MAX_CONCURRENT_ANALYSIS = 2;
const MIN_FOCUS_ENERGY = 5;
const MIN_FOCUS_SEPARATION = 0.08;

const ANALYZABLE_EXTENSIONS = new Set(
  IMAGE_EXTENSIONS.filter((extension) => extension !== "svg" && extension !== "psd")
);

export interface FocusPoint {
  /** Estimated sharpest-region coordinates, normalized from top-left. */
  x: number;
  y: number;
  confidence: number;
}

export interface PhotoAnalysisRecord {
  path: string;
  imageWidth: number;
  imageHeight: number;
  fingerprint: number[];
  hashBits: number[];
  /** A thumbnail-derived estimate; null when the image has no clear peak. */
  focusPoint: FocusPoint | null;
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
  focusPoint: FocusPoint | null;
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
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const leftX = clamp(
        Math.floor(contentLeft + ((column + 0.25) * contentWidth) / 8),
        0,
        ANALYSIS_SIZE - 1
      );
      const rightX = clamp(
        Math.floor(contentLeft + ((column + 1.25) * contentWidth) / 8),
        0,
        ANALYSIS_SIZE - 1
      );
      const sampleY = clamp(
        Math.floor(contentTop + ((row + 0.5) * contentHeight) / 8),
        0,
        ANALYSIS_SIZE - 1
      );
      hashBits.push(
        getGray(imageData, leftX, sampleY) < getGray(imageData, rightX, sampleY) ? 1 : 0
      );
    }
  }

  // Camera-maker AF regions are not consistently exposed by Quick Look, so
  // the first pass uses the strongest local edge-energy peak as a visual cue.
  const tileWidth = Math.max(8, Math.floor(contentWidth / FOCUS_GRID_SIZE));
  const tileHeight = Math.max(8, Math.floor(contentHeight / FOCUS_GRID_SIZE));
  const tileScores: Array<{ score: number; x: number; y: number }> = [];

  for (let tileY = 0; tileY < FOCUS_GRID_SIZE; tileY += 1) {
    for (let tileX = 0; tileX < FOCUS_GRID_SIZE; tileX += 1) {
      const startX = contentLeft + tileX * tileWidth;
      const startY = contentTop + tileY * tileHeight;
      const endX = Math.min(contentLeft + contentWidth - 1, startX + tileWidth);
      const endY = Math.min(contentTop + contentHeight - 1, startY + tileHeight);
      let score = 0;
      let samples = 0;

      for (let y = startY + 1; y < endY - 1; y += 1) {
        for (let x = startX + 1; x < endX - 1; x += 1) {
          const horizontal = Math.abs(getGray(imageData, x + 1, y) - getGray(imageData, x - 1, y));
          const vertical = Math.abs(getGray(imageData, x, y + 1) - getGray(imageData, x, y - 1));
          score += horizontal + vertical;
          samples += 1;
        }
      }

      tileScores.push({
        score: samples > 0 ? score / samples : 0,
        x: tileX,
        y: tileY,
      });
    }
  }

  tileScores.sort((a, b) => b.score - a.score);
  const best = tileScores[0];
  const second = tileScores[1];
  const focusSeparation =
    best && second ? (best.score - second.score) / Math.max(best.score, 1) : 0;
  const hasFocus =
    Boolean(best) && best.score >= MIN_FOCUS_ENERGY && focusSeparation >= MIN_FOCUS_SEPARATION;

  const focusPoint = hasFocus
    ? {
        x: clamp((best.x + 0.5) / FOCUS_GRID_SIZE, 0, 1),
        y: clamp((best.y + 0.5) / FOCUS_GRID_SIZE, 0, 1),
        confidence: clamp(focusSeparation * 4, 0, 1),
      }
    : null;

  return {
    path,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    fingerprint: normalizeFingerprint(fingerprintValues),
    hashBits,
    focusPoint,
  };
}

async function analyzeEntry(entry: FileEntry, key: string, signal: AbortSignal) {
  const cached = featureCache.get(key);
  if (cached) return cached.features;

  if (signal.aborted) return null;
  const thumbnailKey = `photo-analysis:${key}`;
  // Do not accept the generic ARW document icon as an analysis image. It has
  // the same pixels for every failed RAW decode and would create false groups.
  const base64 = await loadFileThumbnail(thumbnailKey, entry.path, ANALYSIS_SIZE, false);
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
  const visualDistance = fingerprintDistance(first.fingerprint, second.fingerprint);
  const hashDistanceValue = hashDistance(first.hashBits, second.hashBits);

  // The low-resolution fingerprint handles exposure and focus changes; the
  // dHash guard keeps nearby but different compositions from being merged.
  return (visualDistance <= 0.72 && hashDistanceValue <= 0.38) || visualDistance <= 0.5;
}

function buildGroups(
  entries: PhotoAnalysisEntry[],
  featuresByPath: Map<string, RawPhotoFeatures>
): Map<string, number | null> {
  const groups = new Map<string, number | null>();
  const candidates: Array<{
    representative: RawPhotoFeatures;
    members: PhotoAnalysisEntry[];
  }> = [];

  for (const item of entries) {
    const features = featuresByPath.get(item.entry.path);
    if (!features) {
      continue;
    }

    const matchingGroup = candidates.find((candidate) =>
      isSameView(candidate.representative, features)
    );
    if (matchingGroup) {
      matchingGroup.members.push(item);
    } else {
      candidates.push({ representative: features, members: [item] });
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
        if (completed % 4 === 0 || completed === entries.length) {
          onUpdate(completed, createPhotoAnalysisRecords(entries, featuresByPath));
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
  featuresByPath: Map<string, RawPhotoFeatures>
): Map<string, PhotoAnalysisRecord> {
  const groups = buildGroups(entries, featuresByPath);
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
  return `hsl(var(--photo-group-${(groupId % 4) + 1}))`;
}
