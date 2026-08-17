import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/types";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import {
  getCachedPhotoMetadata,
  getPhotoMetadataKey,
  loadPhotoMetadata,
  type PhotoMetadata,
} from "@/lib/photoMetadata";

interface PhotoMetadataState {
  key: string | null;
  data: PhotoMetadata | null;
}

export function usePhotoMetadata(entry: FileEntry, enabled = true) {
  const metadataKey = isAnalyzablePhoto(entry) ? getPhotoMetadataKey(entry) : null;
  const [state, setState] = useState<PhotoMetadataState>({ key: null, data: null });
  const entryRef = useRef(entry);
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);
  const cached = metadataKey ? getCachedPhotoMetadata(entry) : undefined;

  useEffect(() => {
    const currentEntry = entryRef.current;
    if (!enabled || !metadataKey || !currentEntry) return;

    const cachedMetadata = getCachedPhotoMetadata(currentEntry);
    if (cachedMetadata !== undefined) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const startTimer = window.setTimeout(() => {
      void loadPhotoMetadata(currentEntry, controller.signal).then((data) => {
        if (!cancelled) {
          setState({ key: metadataKey, data });
        }
      });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      controller.abort();
    };
  }, [enabled, metadataKey]);

  if (cached !== undefined) return cached;
  return state.key === metadataKey ? state.data : null;
}
