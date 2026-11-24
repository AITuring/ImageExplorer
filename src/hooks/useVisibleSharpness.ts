import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildFileThumbnailUrl, loadHtmlImage } from "@/lib/iconCache";
import { extractSharpnessRegionPixels } from "@/lib/sharpnessAnalysis";
import { computeSharpnessVerdictOffThread } from "@/lib/sharpnessWorker";
import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import type { FileEntry } from "@/types";

export type VisibleSharpness = "sharp" | "soft" | "unavailable";

const IMAGE_TYPES = new Set(IMAGE_EXTENSIONS.filter((type) => type !== "svg" && type !== "psd"));
const SOURCE_SIZE = 1024;
const SHARPNESS_CACHE_VERSION = 2;
const SHARPNESS_CONCURRENCY = 3;
const PUBLISH_INTERVAL_MS = 160;
const PUBLISH_BATCH_SIZE = 12;
const SQLITE_PERSIST_BATCH_SIZE = 16;
// Verdicts are tiny scalars; keep a whole large folder so scrolling back does
// not trigger another camera JPEG read for the same file.
const MAX_RESULTS = 5_000;
const results = new Map<string, VisibleSharpness>();

interface PersistedSharpnessRecord {
  path: string;
  modified: number;
  fileSize: number;
  verdict: string;
}

function isPersistedVerdict(value: string): value is VisibleSharpness {
  return value === "sharp" || value === "soft" || value === "unavailable";
}

function persistSharpnessBatch(records: PersistedSharpnessRecord[]) {
  if (records.length === 0) return;
  void invoke("save_cached_photo_sharpness", {
    records,
    sharpnessVersion: SHARPNESS_CACHE_VERSION,
  }).catch(() => undefined);
}

function keyFor(entry: FileEntry) {
  return `${entry.path}\u0000${entry.modified ?? 0}\u0000${entry.size}`;
}

export function isSharpnessAnalyzable(entry: FileEntry) {
  return !entry.is_dir && IMAGE_TYPES.has((entry.extension ?? "").toLowerCase());
}

async function measure(
  entry: FileEntry,
  signal: AbortSignal,
  lowPriority: boolean
): Promise<VisibleSharpness> {
  const url = buildFileThumbnailUrl(
    entry.path,
    entry.modified,
    entry.size,
    SOURCE_SIZE,
    true,
    false,
    lowPriority
  );
  let image: HTMLImageElement;
  try {
    image = await loadHtmlImage(url, signal);
  } catch {
    return "unavailable";
  }
  if (signal.aborted) return "unavailable";
  const region = extractSharpnessRegionPixels(image, { x: 0, y: 0, width: 1, height: 1 }, 1024);
  const isSharp = await computeSharpnessVerdictOffThread(
    region.pixels,
    region.width,
    region.height,
    signal
  );
  return isSharp ? "sharp" : "soft";
}

export function useVisibleSharpness(
  entries: FileEntry[],
  enabled: boolean,
  priorityPaths: string[] = []
) {
  const signature = useMemo(
    () => entries.filter(isSharpnessAnalyzable).map(keyFor).join("\u001f"),
    [entries]
  );
  const [snapshot, setSnapshot] = useState<{
    signature: string;
    verdicts: Map<string, VisibleSharpness>;
  }>({ signature: "", verdicts: new Map() });
  const priorityPathsRef = useRef(priorityPaths);
  const entriesRef = useRef(entries);
  useEffect(() => {
    priorityPathsRef.current = priorityPaths;
  }, [priorityPaths]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const currentEntries = entriesRef.current;
    const verdicts = new Map<string, VisibleSharpness>();
    const missingFromMemory: FileEntry[] = [];
    for (const entry of currentEntries) {
      if (!isSharpnessAnalyzable(entry)) continue;
      const cached = results.get(keyFor(entry));
      if (cached) {
        verdicts.set(entry.path, cached);
      } else {
        missingFromMemory.push(entry);
      }
    }
    const pendingPersist: PersistedSharpnessRecord[] = [];
    let unpublishedCount = 0;
    let lastPublishedAt = performance.now();

    const flush = () => {
      if (unpublishedCount === 0 || controller.signal.aborted) return;
      unpublishedCount = 0;
      lastPublishedAt = performance.now();
      const nextVerdicts = new Map(verdicts);
      startTransition(() => {
        setSnapshot({ signature, verdicts: nextVerdicts });
      });
    };

    const run = async () => {
      // Hydrate persisted sharpness verdicts from SQLite before decoding any
      // 1024px previews so revisits to large photo folders finish instantly.
      let pending = missingFromMemory;
      if (missingFromMemory.length > 0) {
        try {
          const rows = await invoke<PersistedSharpnessRecord[]>("get_cached_photo_sharpness", {
            items: missingFromMemory.map((entry) => ({
              path: entry.path,
              modified: entry.modified ?? 0,
              fileSize: entry.size,
            })),
            sharpnessVersion: SHARPNESS_CACHE_VERSION,
          });
          if (controller.signal.aborted) return;

          if (rows.length > 0) {
            const entryByPath = new Map(missingFromMemory.map((entry) => [entry.path, entry]));
            for (const row of rows) {
              if (!isPersistedVerdict(row.verdict)) continue;
              const entry = entryByPath.get(row.path);
              if (!entry) continue;
              const key = keyFor(entry);
              results.delete(key);
              results.set(key, row.verdict);
              while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
              verdicts.set(entry.path, row.verdict);
              unpublishedCount += 1;
            }
            flush();
            pending = missingFromMemory.filter((entry) => !verdicts.has(entry.path));
          }
        } catch {
          // SQLite cache is best-effort; continue computing uncached items.
        }
      }

      if (controller.signal.aborted || pending.length === 0) return;

      // Brief yield so the initial viewport render commits before sharpness workers start.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 80);
        controller.signal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
      if (controller.signal.aborted) return;

      const pendingByPath = new Map(pending.map((entry) => [entry.path, entry]));
      let next = 0;

      const worker = async () => {
        while (!controller.signal.aborted) {
          let entry: FileEntry | undefined;
          let isViewportPriority = false;
          for (const path of priorityPathsRef.current) {
            entry = pendingByPath.get(path);
            if (entry) {
              isViewportPriority = true;
              break;
            }
          }
          while (!entry && next < pending.length) {
            const candidate = pending[next++];
            entry = pendingByPath.get(candidate.path);
          }
          if (!entry) break;
          pendingByPath.delete(entry.path);

          let verdict: VisibleSharpness;
          try {
            verdict = await measure(entry, controller.signal, !isViewportPriority);
          } catch {
            if (controller.signal.aborted) return;
            verdict = "unavailable";
          }
          if (controller.signal.aborted) return;
          const key = keyFor(entry);
          results.delete(key);
          results.set(key, verdict);
          while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
          verdicts.set(entry.path, verdict);
          if (verdict === "sharp" || verdict === "soft") {
            pendingPersist.push({
              path: entry.path,
              modified: entry.modified ?? 0,
              fileSize: entry.size,
              verdict,
            });
            if (pendingPersist.length >= SQLITE_PERSIST_BATCH_SIZE) {
              persistSharpnessBatch(pendingPersist.splice(0, pendingPersist.length));
            }
          }
          unpublishedCount += 1;
          if (unpublishedCount === 1 && verdicts.size === 1) {
            flush();
          } else if (
            isViewportPriority ||
            unpublishedCount >= PUBLISH_BATCH_SIZE ||
            performance.now() - lastPublishedAt >= PUBLISH_INTERVAL_MS
          ) {
            flush();
          }
        }
      };

      const workerCount = Math.min(SHARPNESS_CONCURRENCY, pending.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (pendingPersist.length > 0) {
        persistSharpnessBatch(pendingPersist.splice(0, pendingPersist.length));
      }
      flush();
    };
    void run();
    return () => {
      controller.abort();
      if (pendingPersist.length > 0) {
        persistSharpnessBatch(pendingPersist.splice(0, pendingPersist.length));
      }
    };
  }, [enabled, signature]);

  return useMemo(() => {
    if (!enabled) return new Map<string, VisibleSharpness>();
    if (snapshot.signature === signature) return snapshot.verdicts;
    const initial = new Map<string, VisibleSharpness>();
    for (const entry of entries) {
      const cached = results.get(keyFor(entry));
      if (cached) initial.set(entry.path, cached);
    }
    return initial;
  }, [enabled, entries, signature, snapshot]);
}
