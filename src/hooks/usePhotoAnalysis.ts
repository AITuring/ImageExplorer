import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@/types";
import {
  analyzePhotoEntries,
  getPhotoAnalysisEntries,
  type PhotoAnalysisProgress,
  type PhotoAnalysisRecord,
} from "@/lib/photoAnalysis";

const EMPTY_RECORDS = new Map<string, PhotoAnalysisRecord>();
const INITIAL_PROGRESS: PhotoAnalysisProgress = {
  completed: 0,
  total: 0,
  isAnalyzing: false,
};

interface PhotoAnalysisState {
  signature: string;
  records: Map<string, PhotoAnalysisRecord>;
  progress: PhotoAnalysisProgress;
}

export function usePhotoAnalysis(entries: FileEntry[], enabled: boolean) {
  const [state, setState] = useState<PhotoAnalysisState>({
    signature: "",
    records: EMPTY_RECORDS,
    progress: INITIAL_PROGRESS,
  });
  const generationRef = useRef(0);

  const analysisEntries = useMemo(
    () => (enabled ? getPhotoAnalysisEntries(entries) : []),
    [enabled, entries]
  );
  const analysisSignature = useMemo(
    () => analysisEntries.map((item) => item.key).join("\u001f"),
    [analysisEntries]
  );
  const visibleState: PhotoAnalysisState =
    state.signature === analysisSignature
      ? state
      : {
          signature: analysisSignature,
          records: EMPTY_RECORDS,
          progress: {
            completed: 0,
            total: analysisEntries.length,
            isAnalyzing: enabled && analysisEntries.length > 0,
          },
        };

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();

    if (!enabled || analysisEntries.length === 0) {
      return () => controller.abort();
    }

    const publishProgress = (
      completed: number,
      partialRecords: Map<string, PhotoAnalysisRecord>
    ) => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setState({
        signature: analysisSignature,
        records: partialRecords,
        progress: {
          completed,
          total: analysisEntries.length,
          isAnalyzing: completed < analysisEntries.length,
        },
      });
      // Publish partial groups so visible bursts get a background while the
      // rest of a large folder is still being decoded.
    };

    void analyzePhotoEntries(analysisEntries, controller.signal, publishProgress)
      .then((nextRecords) => {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        startTransition(() =>
          setState({
            signature: analysisSignature,
            records: nextRecords,
            progress: {
              completed: analysisEntries.length,
              total: analysisEntries.length,
              isAnalyzing: false,
            },
          })
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.warn("Photo analysis stopped", error);
          setState({
            signature: analysisSignature,
            records: EMPTY_RECORDS,
            progress: {
              completed: 0,
              total: analysisEntries.length,
              isAnalyzing: false,
            },
          });
        }
      });

    return () => controller.abort();
  }, [analysisEntries, analysisSignature, enabled]);

  return { records: visibleState.records, progress: visibleState.progress };
}
