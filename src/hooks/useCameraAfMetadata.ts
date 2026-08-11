import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/types";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import {
  getCachedCameraAfMetadata,
  getCameraAfMetadataKey,
  loadCameraAfMetadata,
  type CameraAfLoadPriority,
  type CameraAfMetadata,
} from "@/lib/cameraAfMetadata";

export function useCameraAfMetadata(
  entry: FileEntry | null,
  enabled: boolean,
  priority: CameraAfLoadPriority = "background"
) {
  const key = enabled && entry && isAnalyzablePhoto(entry) ? getCameraAfMetadataKey(entry) : null;
  const [state, setState] = useState<{ key: string | null; data: CameraAfMetadata | null }>({
    key: null,
    data: null,
  });
  const entryRef = useRef(entry);
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);
  const cached = key && entry ? getCachedCameraAfMetadata(entry) : undefined;

  useEffect(() => {
    const currentEntry = entryRef.current;
    if (!enabled || !key || !currentEntry) {
      return;
    }

    const cachedMetadata = getCachedCameraAfMetadata(currentEntry);
    if (cachedMetadata !== undefined) {
      return;
    }

    let cancelled = false;
    void loadCameraAfMetadata(currentEntry, priority).then((data) => {
      if (!cancelled) setState({ key, data });
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, key, priority]);

  if (!enabled || !key) return null;
  if (cached !== undefined) return cached;
  return state.key === key ? state.data : null;
}
