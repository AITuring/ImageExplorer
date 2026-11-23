import { hasFinderTag } from "./finderTags.ts";

export type FolderFormatFilter = "all" | "raw" | "jpeg" | "video";
export type FolderSharpnessFilter = "all" | "sharp" | "soft";

export interface FolderFilterState {
  query: string;
  format: FolderFormatFilter;
  sharpness: FolderSharpnessFilter;
  tagId: string | null;
  pairRawJpeg: boolean;
}

export const DEFAULT_FOLDER_FILTER: FolderFilterState = {
  query: "",
  format: "all",
  sharpness: "all",
  tagId: null,
  pairRawJpeg: false,
};

const RAW_EXTS = new Set([
  "arw",
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "raf",
  "orf",
  "rw2",
  "pef",
  "srw",
  "dcr",
  "kdc",
  "3fr",
  "iiq",
  "x3f",
  "dng",
]);

const JPEG_EXTS = new Set(["jpg", "jpeg", "heic", "heif", "png", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v", "mts"]);

export interface FilterableFolderEntry {
  name: string;
  path: string;
  is_dir: boolean;
  extension?: string | null;
  tags?: string[];
}

export function hasActiveFolderFilter(filter: FolderFilterState): boolean {
  return (
    filter.query.trim().length > 0 ||
    filter.format !== "all" ||
    filter.sharpness !== "all" ||
    filter.tagId !== null
  );
}

function getEntryExtension(entry: FilterableFolderEntry): string {
  if (entry.extension) return entry.extension.toLowerCase();
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
}

export function filterFolderEntries<T extends FilterableFolderEntry>(
  entries: T[],
  filter: FolderFilterState,
  sharpnessMap?: ReadonlyMap<string, string>
): T[] {
  if (!hasActiveFolderFilter(filter)) return entries;

  const query = filter.query.trim().toLowerCase();

  return entries.filter((entry) => {
    if (query && !entry.name.toLowerCase().includes(query)) {
      return false;
    }

    if (filter.format !== "all") {
      if (entry.is_dir) return false;
      const ext = getEntryExtension(entry);
      if (filter.format === "raw" && !RAW_EXTS.has(ext)) return false;
      if (filter.format === "jpeg" && !JPEG_EXTS.has(ext)) return false;
      if (filter.format === "video" && !VIDEO_EXTS.has(ext)) return false;
    }

    if (filter.sharpness !== "all") {
      if (entry.is_dir) return false;
      const verdict = sharpnessMap?.get(entry.path);
      if (verdict !== filter.sharpness) return false;
    }

    if (filter.tagId !== null && !hasFinderTag(entry.tags, filter.tagId)) {
      return false;
    }

    return true;
  });
}
