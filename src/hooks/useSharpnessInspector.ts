import { useCallback, useEffect, useRef, useState } from "react";
import {
  extractSharpnessRegionPixels,
  getSharpnessSourceRequestSize,
  type NormalizedRect,
  type SharpnessMaskResult,
} from "@/lib/sharpnessAnalysis";
import { computeSharpnessMaskOffThread } from "@/lib/sharpnessWorker";
import { getFileThumbnailCacheKey, loadFileThumbnail } from "@/lib/iconCache";
import type { FileEntry } from "@/types";

export type SharpnessInspectorStatus =
  | "waiting"
  | "selecting"
  | "analyzing"
  | "ready"
  | "empty"
  | "too-small"
  | "error";

interface UseSharpnessInspectorOptions {
  entry: FileEntry;
  displayedDimensions: { width: number; height: number } | null;
  autoStart?: boolean;
}

interface CachedSourceImage {
  requestSize: number;
  image: HTMLImageElement;
}

const FULL_IMAGE_SELECTION: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
const SHARPNESS_ANALYSIS_VERSION = 1;
const MAX_CACHED_FULL_IMAGE_RESULTS = 5;
const fullImageResultCache = new Map<string, SharpnessMaskResult>();

function getFullImageResultCacheKey(entry: FileEntry) {
  return `${entry.path}\u0000${entry.modified ?? 0}\u0000${entry.size}\u0000${SHARPNESS_ANALYSIS_VERSION}`;
}

function getCachedFullImageResult(key: string) {
  const cached = fullImageResultCache.get(key);
  if (!cached) return null;
  fullImageResultCache.delete(key);
  fullImageResultCache.set(key, cached);
  return cached;
}

function peekCachedFullImageResult(key: string) {
  return fullImageResultCache.get(key) ?? null;
}

function cacheFullImageResult(key: string, result: SharpnessMaskResult) {
  fullImageResultCache.delete(key);
  fullImageResultCache.set(key, result);
  while (fullImageResultCache.size > MAX_CACHED_FULL_IMAGE_RESULTS) {
    const oldest = fullImageResultCache.keys().next().value as string | undefined;
    if (!oldest) break;
    fullImageResultCache.delete(oldest);
  }
}

function statusForResult(result: SharpnessMaskResult): SharpnessInspectorStatus {
  return result.highlightedPixels > 0 ? "ready" : "empty";
}

function isFullImageSelection(selection: NormalizedRect) {
  return selection.x === 0 && selection.y === 0 && selection.width === 1 && selection.height === 1;
}

function abortError() {
  return new DOMException("Sharpness analysis was cancelled", "AbortError");
}

function decodeThumbnail(base64: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      image.src = "";
      reject(abortError());
    };

    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Unable to decode the sharpness preview"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    image.src = `data:image/png;base64,${base64}`;
  });
}

function waitForNextFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    });
    const handleAbort = () => {
      window.cancelAnimationFrame(frame);
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export function useSharpnessInspector({
  entry,
  displayedDimensions,
  autoStart = false,
}: UseSharpnessInspectorOptions) {
  const analysisKey = getFullImageResultCacheKey(entry);
  const [enabled, setEnabled] = useState(autoStart);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<NormalizedRect | null>(null);
  const [result, setResult] = useState<SharpnessMaskResult | null>(() =>
    peekCachedFullImageResult(analysisKey)
  );
  const [status, setStatus] = useState<SharpnessInspectorStatus>(() =>
    result ? statusForResult(result) : "waiting"
  );
  const sourceImageRef = useRef<CachedSourceImage | null>(null);
  const displayedImageRef = useRef<HTMLImageElement | null>(null);
  const autoAnalysisStartedRef = useRef(Boolean(result));
  const autoAnalysisFrameRef = useRef<number | null>(null);
  const analysisControllerRef = useRef<AbortController | null>(null);
  const analysisVersionRef = useRef(0);
  const analysisKeyRef = useRef(analysisKey);

  const cancelAnalysis = useCallback(() => {
    if (autoAnalysisFrameRef.current !== null) {
      window.cancelAnimationFrame(autoAnalysisFrameRef.current);
      autoAnalysisFrameRef.current = null;
    }
    analysisVersionRef.current += 1;
    analysisControllerRef.current?.abort();
    analysisControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (analysisKeyRef.current === analysisKey) {
      return;
    }

    analysisKeyRef.current = analysisKey;
    const cachedResult = getCachedFullImageResult(analysisKey);
    sourceImageRef.current = null;
    displayedImageRef.current = null;
    autoAnalysisStartedRef.current = Boolean(cachedResult);
    cancelAnalysis();
    setEnabled(autoStart);
    setStatus(cachedResult ? statusForResult(cachedResult) : "waiting");
    setSelectionMode(false);
    setSelection(null);
    setResult(cachedResult);
  }, [analysisKey, autoStart, cancelAnalysis]);

  const loadSourceImage = useCallback(
    async (requestedSize: number, signal: AbortSignal) => {
      const cached = sourceImageRef.current;
      if (cached && cached.requestSize >= requestedSize) {
        return cached.image;
      }

      const cacheKey = getFileThumbnailCacheKey(
        entry.path,
        entry.modified,
        entry.size,
        requestedSize
      );
      const base64 = await loadFileThumbnail(
        cacheKey,
        entry.path,
        requestedSize,
        false,
        signal,
        "interactive",
        false,
        false
      );
      if (!base64) {
        if (signal.aborted) throw abortError();
        throw new Error("Unable to load a sharpness preview");
      }

      const image = await decodeThumbnail(base64, signal);
      sourceImageRef.current = { requestSize: requestedSize, image };
      return image;
    },
    [entry.modified, entry.path, entry.size]
  );

  const analyzeSelection = useCallback(
    async (nextSelection: NormalizedRect, preferredImage?: HTMLImageElement | null) => {
      cancelAnalysis();
      const isFullImage = isFullImageSelection(nextSelection);
      const cachedResult = isFullImage ? getCachedFullImageResult(analysisKey) : null;
      if (cachedResult) {
        autoAnalysisStartedRef.current = true;
        setSelection(null);
        setSelectionMode(false);
        setResult(cachedResult);
        setStatus(statusForResult(cachedResult));
        return;
      }

      const version = analysisVersionRef.current;
      const controller = new AbortController();
      analysisControllerRef.current = controller;
      setSelection(isFullImage ? null : nextSelection);
      setSelectionMode(false);
      setResult(null);
      setStatus("analyzing");

      try {
        const requestSize = getSharpnessSourceRequestSize(nextSelection, displayedDimensions);
        const displayedImage = preferredImage ?? displayedImageRef.current;
        const canUseDisplayedImage = Boolean(
          displayedImage &&
          (preferredImage ||
            Math.max(displayedImage.naturalWidth, displayedImage.naturalHeight) >= requestSize)
        );
        let image = canUseDisplayedImage
          ? displayedImage!
          : await loadSourceImage(requestSize, controller.signal);

        const analyzeImage = async (candidate: HTMLImageElement) => {
          if (displayedDimensions) {
            const displayedAspect = displayedDimensions.width / displayedDimensions.height;
            const sourceAspect = candidate.naturalWidth / candidate.naturalHeight;
            const aspectDifference =
              Math.abs(displayedAspect - sourceAspect) / Math.max(displayedAspect, sourceAspect);
            if (aspectDifference > 0.025) {
              throw new Error("Sharpness preview orientation does not match the displayed image");
            }
          }

          // Yield once so the analyzing state is painted before the bounded
          // source crop is copied. The high-frequency pass itself runs in a
          // worker so it cannot stall preview controls or image navigation.
          await waitForNextFrame(controller.signal);
          const region = extractSharpnessRegionPixels(candidate, nextSelection);
          return computeSharpnessMaskOffThread(
            region.pixels,
            region.width,
            region.height,
            controller.signal
          );
        };

        let nextResult: SharpnessMaskResult;
        try {
          nextResult = await analyzeImage(image);
        } catch (error) {
          if (controller.signal.aborted || image !== displayedImage) {
            throw error;
          }

          // Browser-native file URLs can be canvas-tainted in some WebView
          // configurations. Fall back to the existing safe thumbnail bridge
          // only in that case; the normal path reuses the already shown image.
          image = await loadSourceImage(requestSize, controller.signal);
          nextResult = await analyzeImage(image);
        }
        if (controller.signal.aborted || version !== analysisVersionRef.current) return;

        if (isFullImage) {
          cacheFullImageResult(analysisKey, nextResult);
        }
        setResult(nextResult);
        setStatus(statusForResult(nextResult));
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        if (version === analysisVersionRef.current) {
          setResult(null);
          setStatus("error");
        }
      } finally {
        if (version === analysisVersionRef.current) {
          analysisControllerRef.current = null;
        }
      }
    },
    [analysisKey, cancelAnalysis, displayedDimensions, loadSourceImage]
  );

  const analyzeSelectionRef = useRef(analyzeSelection);
  analyzeSelectionRef.current = analyzeSelection;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const statusRef = useRef(status);
  statusRef.current = status;
  const resultRef = useRef(result);
  resultRef.current = result;
  const autoStartRef = useRef(autoStart);
  autoStartRef.current = autoStart;

  const scheduleAutoAnalysis = useCallback((image: HTMLImageElement) => {
    autoAnalysisStartedRef.current = true;
    autoAnalysisFrameRef.current = window.requestAnimationFrame(() => {
      autoAnalysisFrameRef.current = null;
      if (displayedImageRef.current === image) {
        void analyzeSelectionRef.current(FULL_IMAGE_SELECTION, image);
      }
    });
  }, []);

  const registerPreviewImage = useCallback(
    (image: HTMLImageElement) => {
      displayedImageRef.current = image;
      if (autoAnalysisFrameRef.current !== null) {
        window.cancelAnimationFrame(autoAnalysisFrameRef.current);
        autoAnalysisFrameRef.current = null;
        autoAnalysisStartedRef.current = false;
      }
      if (
        !autoStartRef.current ||
        !enabledRef.current ||
        autoAnalysisStartedRef.current ||
        resultRef.current
      ) {
        return;
      }

      scheduleAutoAnalysis(image);
    },
    [scheduleAutoAnalysis]
  );

  useEffect(() => {
    // React Strict Mode intentionally runs a mount cleanup/setup cycle in
    // development. If that cleanup cancelled an already scheduled auto-pass,
    // restore it from the registered preview during the second setup.
    const displayedImage = displayedImageRef.current;
    if (
      autoStartRef.current &&
      enabledRef.current &&
      autoAnalysisStartedRef.current &&
      autoAnalysisFrameRef.current === null &&
      statusRef.current === "waiting" &&
      !resultRef.current &&
      displayedImage
    ) {
      scheduleAutoAnalysis(displayedImage);
    }

    return cancelAnalysis;
  }, [cancelAnalysis, scheduleAutoAnalysis]);

  const toggle = useCallback(() => {
    if (!enabled) {
      setEnabled(true);
      setSelectionMode(false);
      if (!result) {
        const displayedImage = displayedImageRef.current;
        if (displayedImage) {
          autoAnalysisStartedRef.current = true;
          void analyzeSelection(FULL_IMAGE_SELECTION, displayedImage);
        } else {
          setStatus("waiting");
        }
      }
      return;
    }

    cancelAnalysis();
    setEnabled(false);
    setSelectionMode(false);
    if (status === "waiting" || status === "analyzing" || status === "selecting") {
      setSelection(null);
      setResult(null);
      setStatus("waiting");
    }
  }, [analyzeSelection, cancelAnalysis, enabled, result, status]);

  const beginSelection = useCallback(() => {
    cancelAnalysis();
    setEnabled(true);
    setSelectionMode(true);
    setStatus("selecting");
  }, [cancelAnalysis]);

  const commitSelection = useCallback(
    (nextSelection: NormalizedRect) => {
      setEnabled(true);
      setSelectionMode(false);
      void analyzeSelection(nextSelection);
    },
    [analyzeSelection]
  );

  const analyzeFullImage = useCallback(() => {
    setEnabled(true);
    setSelectionMode(false);
    void analyzeSelection(FULL_IMAGE_SELECTION);
  }, [analyzeSelection]);

  const reportTooSmall = useCallback(() => {
    cancelAnalysis();
    setSelectionMode(true);
    setStatus("too-small");
  }, [cancelAnalysis]);

  const resetSelection = useCallback(() => {
    beginSelection();
  }, [beginSelection]);

  const escape = useCallback(() => {
    if (selectionMode) {
      setSelectionMode(false);
      setStatus(result ? (result.highlightedPixels > 0 ? "ready" : "empty") : "waiting");
      return;
    }
    cancelAnalysis();
    setEnabled(false);
  }, [cancelAnalysis, result, selectionMode]);

  return {
    enabled,
    status,
    selectionMode,
    selection,
    result,
    registerPreviewImage,
    toggle,
    beginSelection,
    commitSelection,
    analyzeFullImage,
    reportTooSmall,
    resetSelection,
    escape,
  };
}
