import { useEffect, useMemo, useState } from "react";
import type { FileEntry } from "@/types";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import { getPhotoMetadataKey, loadPhotoMetadata, type PhotoMetadata } from "@/lib/photoMetadata";

interface PhotoMetadataState {
  key: string | null;
  data: PhotoMetadata | null;
}

export function usePhotoMetadata(entry: FileEntry) {
  const metadataKey = useMemo(
    () => (isAnalyzablePhoto(entry) ? getPhotoMetadataKey(entry) : null),
    [entry]
  );
  const [state, setState] = useState<PhotoMetadataState>({ key: null, data: null });

  useEffect(() => {
    if (!metadataKey) return;

    let cancelled = false;
    void loadPhotoMetadata(entry).then((data) => {
      if (!cancelled) {
        setState({ key: metadataKey, data });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [entry, metadataKey]);

  return state.key === metadataKey ? state.data : null;
}
