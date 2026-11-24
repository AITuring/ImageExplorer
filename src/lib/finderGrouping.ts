import type { FileEntry } from "../types/index.ts";

export type GroupByField = "none" | "kind" | "date" | "size" | "tag";

export interface EntryGroup {
  id: string;
  labelKey?: string;
  rawLabel?: string;
  entries: FileEntry[];
}

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
const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "bmp",
  "tiff",
  "tif",
  "svg",
  "avif",
  "psd",
]);
const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "mkv", "avi", "webm", "mts", "m2ts"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "m4a", "ogg", "aiff"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg"]);
const DOC_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "md",
  "rtf",
  "pages",
  "numbers",
  "key",
  "csv",
  "json",
]);

interface BucketInfo {
  id: string;
  labelKey?: string;
  rawLabel?: string;
  order: number;
}

function getKindBucket(entry: FileEntry): BucketInfo {
  if (entry.is_dir) return { id: "kind:folder", labelKey: "file_list.group.kind_folder", order: 0 };
  const ext = (entry.extension ?? "").toLowerCase();
  if (RAW_EXTS.has(ext)) return { id: "kind:raw", labelKey: "file_list.group.kind_raw", order: 1 };
  if (IMAGE_EXTS.has(ext))
    return { id: "kind:image", labelKey: "file_list.group.kind_image", order: 2 };
  if (VIDEO_EXTS.has(ext))
    return { id: "kind:video", labelKey: "file_list.group.kind_video", order: 3 };
  if (AUDIO_EXTS.has(ext))
    return { id: "kind:audio", labelKey: "file_list.group.kind_audio", order: 4 };
  if (DOC_EXTS.has(ext))
    return { id: "kind:document", labelKey: "file_list.group.kind_document", order: 5 };
  if (ARCHIVE_EXTS.has(ext))
    return { id: "kind:archive", labelKey: "file_list.group.kind_archive", order: 6 };
  return { id: "kind:other", labelKey: "file_list.group.kind_other", order: 7 };
}

function getDateBucket(entry: FileEntry, nowMs: number): BucketInfo {
  if (entry.modified === null || entry.modified === undefined) {
    return { id: "date:unknown", labelKey: "file_list.group.date_unknown", order: 999999 };
  }
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const itemMs = entry.modified * 1000;
  const dayMs = 86_400_000;

  if (itemMs >= startOfToday) {
    return { id: "date:today", labelKey: "file_list.group.date_today", order: 0 };
  }
  if (itemMs >= startOfToday - dayMs) {
    return { id: "date:yesterday", labelKey: "file_list.group.date_yesterday", order: 1 };
  }
  if (itemMs >= startOfToday - 7 * dayMs) {
    return { id: "date:week", labelKey: "file_list.group.date_last_7_days", order: 2 };
  }
  if (itemMs >= startOfToday - 30 * dayMs) {
    return { id: "date:month", labelKey: "file_list.group.date_last_30_days", order: 3 };
  }

  const d = new Date(itemMs);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  // Newer months first
  const order = 10 + (9999 * 12 - (d.getFullYear() * 12 + d.getMonth()));
  return { id: `date:${ym}`, rawLabel: ym, order };
}

function getSizeBucket(entry: FileEntry): BucketInfo {
  if (entry.is_dir) return { id: "size:folder", labelKey: "file_list.group.kind_folder", order: 0 };
  const mb = 1024 * 1024;
  if (entry.size >= 100 * mb) {
    return { id: "size:huge", labelKey: "file_list.group.size_huge", order: 1 };
  }
  if (entry.size >= 10 * mb) {
    return { id: "size:large", labelKey: "file_list.group.size_large", order: 2 };
  }
  if (entry.size >= mb) {
    return { id: "size:medium", labelKey: "file_list.group.size_medium", order: 3 };
  }
  return { id: "size:small", labelKey: "file_list.group.size_small", order: 4 };
}

function getTagBucket(entry: FileEntry): BucketInfo {
  const firstTag = entry.tags && entry.tags.length > 0 ? entry.tags[0] : null;
  if (!firstTag) {
    return { id: "tag:none", labelKey: "file_list.group.tag_none", order: 999 };
  }
  return { id: `tag:${firstTag.toLowerCase()}`, rawLabel: firstTag, order: 0 };
}

export function groupFileEntries(
  entries: FileEntry[],
  groupBy: GroupByField,
  nowMs: number = Date.now()
): EntryGroup[] {
  if (groupBy === "none") {
    return [{ id: "all", entries }];
  }

  const map = new Map<
    string,
    { id: string; labelKey?: string; rawLabel?: string; order: number; entries: FileEntry[] }
  >();

  for (const entry of entries) {
    const bucket =
      groupBy === "kind"
        ? getKindBucket(entry)
        : groupBy === "date"
          ? getDateBucket(entry, nowMs)
          : groupBy === "size"
            ? getSizeBucket(entry)
            : getTagBucket(entry);

    let group = map.get(bucket.id);
    if (!group) {
      group = {
        id: bucket.id,
        labelKey: bucket.labelKey,
        rawLabel: bucket.rawLabel,
        order: bucket.order,
        entries: [],
      };
      map.set(bucket.id, group);
    }
    group.entries.push(entry);
  }

  return Array.from(map.values())
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return (a.rawLabel ?? a.id).localeCompare(b.rawLabel ?? b.id);
    })
    .map(({ id, labelKey, rawLabel, entries: groupEntries }) => ({
      id,
      labelKey,
      rawLabel,
      entries: groupEntries,
    }));
}
