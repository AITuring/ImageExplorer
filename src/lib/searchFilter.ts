export type SearchKindFilter = "all" | "image" | "raw" | "video" | "document" | "folder";

const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "svg",
  "heic",
  "heif",
  "tif",
  "tiff",
  "avif",
  "ico",
]);

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

const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "3gp", "mts"]);

const DOCUMENT_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "txt",
  "md",
  "rtf",
  "pages",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "numbers",
  "key",
  "csv",
  "odt",
  "ods",
  "epub",
]);

export interface SearchFilterItem {
  name: string;
  is_dir: boolean;
  extension?: string | null;
}

function resolveExtension(item: SearchFilterItem): string {
  if (item.extension) return item.extension.toLowerCase();
  const dot = item.name.lastIndexOf(".");
  return dot > 0 ? item.name.slice(dot + 1).toLowerCase() : "";
}

export function matchesSearchKindFilter(item: SearchFilterItem, filter: SearchKindFilter): boolean {
  if (filter === "all") return true;
  if (filter === "folder") return item.is_dir;
  if (item.is_dir) return false;
  const ext = resolveExtension(item);
  if (!ext) return false;
  switch (filter) {
    case "image":
      return IMAGE_EXTS.has(ext) || RAW_EXTS.has(ext);
    case "raw":
      return RAW_EXTS.has(ext);
    case "video":
      return VIDEO_EXTS.has(ext);
    case "document":
      return DOCUMENT_EXTS.has(ext);
    default:
      return true;
  }
}

export function filterSearchResultsByKind<T extends SearchFilterItem>(
  items: T[],
  filter: SearchKindFilter
): T[] {
  if (filter === "all") return items;
  return items.filter((item) => matchesSearchKindFilter(item, filter));
}
