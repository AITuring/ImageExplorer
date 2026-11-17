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

export function isSharpnessAnalyzable(entry: FileEntry) {
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
    () => entries.filter(isSharpnessAnalyzable).map(keyFor).join("\u001f"),
    [entries]
  );
  const [snapshot, setSnapshot] = useState<{
    signature: string;
    verdicts: Map<string, VisibleSharpness>;
  }>({ signature: "", verdicts: new Map() });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const verdicts = new Map<string, VisibleSharpness>();
    for (const entry of entries) {
      const cached = results.get(keyFor(entry));
      if (cached) verdicts.set(entry.path, cached);
    }
    setSnapshot({ signature, verdicts: new Map(verdicts) });
    const pending = entries.filter(
      (entry) => isSharpnessAnalyzable(entry) && !results.has(keyFor(entry))
    );
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
        verdicts.set(entry.path, verdict);
        setSnapshot({ signature, verdicts: new Map(verdicts) });
      }
    };
    void worker();
    return () => controller.abort();
  }, [enabled, entries, signature]);

  return useMemo(
    () =>
      enabled && snapshot.signature === signature
        ? snapshot.verdicts
        : new Map<string, VisibleSharpness>(),
    [enabled, signature, snapshot]
  );
}
