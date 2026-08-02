import { useEffect, useState } from "react";
import type { FileEntry } from "@/types";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import {
  getCameraAfMetadataKey,
  loadCameraAfMetadata,
  type CameraAfMetadata,
} from "@/lib/cameraAfMetadata";

export function useCameraAfMetadata(entry: FileEntry, enabled: boolean) {
  const key = enabled && isAnalyzablePhoto(entry) ? getCameraAfMetadataKey(entry) : null;
  const [state, setState] = useState<{ key: string | null; data: CameraAfMetadata | null }>({
    key: null,
    data: null,
  });

  useEffect(() => {
    if (!enabled || !key) {
      return;
    }

    let cancelled = false;
    void loadCameraAfMetadata(entry).then((data) => {
      if (!cancelled) setState({ key, data });
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, entry, key]);

  return enabled && state.key === key ? state.data : null;
}
