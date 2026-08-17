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
  const entryKey = entry && isAnalyzablePhoto(entry) ? getCameraAfMetadataKey(entry) : null;
  const key = enabled ? entryKey : null;
  const [state, setState] = useState<{ key: string | null; data: CameraAfMetadata | null }>({
    key: null,
    data: null,
  });
  const entryRef = useRef(entry);
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);
  const cached = entryKey && entry ? getCachedCameraAfMetadata(entry) : undefined;

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
    const controller = new AbortController();
    const startDelay = priority === "interactive" ? 0 : 120;
    const start = () => {
      void loadCameraAfMetadata(currentEntry, priority, controller.signal).then((data) => {
        if (!cancelled) setState({ key, data });
      });
    };
    const startTimer = startDelay > 0 ? window.setTimeout(start, startDelay) : null;
    if (startDelay === 0) start();

    return () => {
      cancelled = true;
      if (startTimer !== null) window.clearTimeout(startTimer);
      controller.abort();
    };
  }, [enabled, key, priority]);

  if (!key) return enabled ? null : (cached ?? null);
  if (cached !== undefined) return cached;
  return state.key === key ? state.data : null;
}
