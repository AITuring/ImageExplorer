import { useEffect, useMemo, useState } from "react";
import { getFileThumbnailCacheKey, loadFileThumbnail } from "@/lib/iconCache";
import { extractSharpnessRegionPixels } from "@/lib/sharpnessAnalysis";
import { computeSharpnessMaskOffThread } from "@/lib/sharpnessWorker";
import { IMAGE_EXTENSIONS } from "@/constants/fileTypes";
import type { FileEntry } from "@/types";

export type VisibleSharpness = "sharp" | "soft" | "unavailable";

const IMAGE_TYPES = new Set(IMAGE_EXTENSIONS.filter((type) => type !== "svg" && type !== "psd"));
const SOURCE_SIZE = 1024;
// Verdicts are tiny scalars; keep a whole large folder so scrolling back does
// not trigger another camera JPEG read for the same file.
const MAX_RESULTS = 5_000;
const results = new Map<string, VisibleSharpness>();

function keyFor(entry: FileEntry) {
  return `${entry.path}\u0000${entry.modified ?? 0}\u0000${entry.size}`;
}

function isAnalyzable(entry: FileEntry) {
  return !entry.is_dir && IMAGE_TYPES.has((entry.extension ?? "").toLowerCase());
}

async function measure(entry: FileEntry, signal: AbortSignal): Promise<VisibleSharpness> {
  const thumbnailKey =
    getFileThumbnailCacheKey(entry.path, entry.modified, entry.size, SOURCE_SIZE) +
    ":embedded-sharpness";
  const base64 = await loadFileThumbnail(
    thumbnailKey,
    entry.path,
    SOURCE_SIZE,
    false,
    signal,
    "background",
    true,
    false
  );
  if (!base64) return "unavailable";
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  if (signal.aborted) return "unavailable";
  const region = extractSharpnessRegionPixels(image, { x: 0, y: 0, width: 1, height: 1 }, 1024);
  const result = await computeSharpnessMaskOffThread(
    region.pixels,
    region.width,
    region.height,
    signal
  );
  return result.highlightedPixels > 0 ? "sharp" : "soft";
}

export function useVisibleSharpness(entries: FileEntry[], enabled: boolean) {
  const signature = useMemo(
    () => entries.filter(isAnalyzable).map(keyFor).join("\u001f"),
    [entries]
  );
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const pending = entries.filter((entry) => isAnalyzable(entry) && !results.has(keyFor(entry)));
    let next = 0;
    const worker = async () => {
      while (!controller.signal.aborted && next < pending.length) {
        const entry = pending[next++];
        let verdict: VisibleSharpness;
        try {
          verdict = await measure(entry, controller.signal);
        } catch {
          if (controller.signal.aborted) return;
          verdict = "unavailable";
        }
        if (controller.signal.aborted) return;
        const key = keyFor(entry);
        results.delete(key);
        results.set(key, verdict);
        while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
        setVersion((current) => current + 1);
      }
    };
    void worker();
    return () => controller.abort();
  }, [enabled, entries, signature]);

  return useMemo(() => {
    void version;
    const visible = new Map<string, VisibleSharpness>();
    if (enabled) {
      for (const entry of entries) {
        const result = results.get(keyFor(entry));
        if (result) visible.set(entry.path, result);
      }
    }
    return visible;
  }, [enabled, entries, version]);
}
