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

export function usePhotoMetadata(entry: FileEntry) {
  const metadataKey = isAnalyzablePhoto(entry) ? getPhotoMetadataKey(entry) : null;
  const [state, setState] = useState<PhotoMetadataState>({ key: null, data: null });
  const entryRef = useRef(entry);
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);
  const cached = metadataKey ? getCachedPhotoMetadata(entry) : undefined;

  useEffect(() => {
    const currentEntry = entryRef.current;
    if (!metadataKey || !currentEntry) return;

    const cachedMetadata = getCachedPhotoMetadata(currentEntry);
    if (cachedMetadata !== undefined) {
      return;
    }

    let cancelled = false;
    void loadPhotoMetadata(currentEntry).then((data) => {
      if (!cancelled) {
        setState({ key: metadataKey, data });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [metadataKey]);

  if (cached !== undefined) return cached;
  return state.key === metadataKey ? state.data : null;
}
