import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@/types";
import {
  analyzePhotoEntries,
  getPhotoAnalysisEntries,
  type PhotoAnalysisProgress,
  type PhotoAnalysisRecord,
} from "@/lib/photoAnalysis";
import { usePhotoAnalysisProgress } from "@/stores/photoAnalysisProgress";

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

export function usePhotoAnalysis(
  entries: FileEntry[],
  enabled: boolean,
  paused = false,
  priorityPath?: string,
  scopePath?: string
) {
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
  const processingEntries = useMemo(() => {
    if (!enabled) return [];
    if (!paused) return analysisEntries;
    if (!priorityPath) return [];
    return analysisEntries.filter((item) => item.entry.path === priorityPath);
  }, [analysisEntries, enabled, paused, priorityPath]);
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
  const {
    completed: visibleCompleted,
    total: visibleTotal,
    isAnalyzing: visibleIsAnalyzing,
  } = visibleState.progress;

  useEffect(() => {
    if (!scopePath) return;

    const progressStore = usePhotoAnalysisProgress.getState();
    if (!enabled || paused) {
      progressStore.setProgress(scopePath, INITIAL_PROGRESS);
    } else {
      progressStore.setProgress(scopePath, {
        completed: visibleCompleted,
        total: visibleTotal,
        isAnalyzing: visibleIsAnalyzing,
      });
    }

    return () => progressStore.clear(scopePath);
  }, [
    analysisSignature,
    enabled,
    paused,
    scopePath,
    visibleCompleted,
    visibleIsAnalyzing,
    visibleTotal,
  ]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();

    if (!enabled || processingEntries.length === 0) {
      return () => controller.abort();
    }

    const publishProgress = (
      completed: number,
      partialRecords: Map<string, PhotoAnalysisRecord>
    ) => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setState((current) => {
        const records = new Map(
          current.signature === analysisSignature ? current.records : EMPTY_RECORDS
        );
        partialRecords.forEach((record, path) => records.set(path, record));
        return {
          signature: analysisSignature,
          records,
          progress: {
            completed,
            total: processingEntries.length,
            isAnalyzing: completed < processingEntries.length,
          },
        };
      });
      // Publish partial regions so visible bursts get focus feedback while
      // the rest of a large folder is still being decoded. Group colors are
      // assigned once the complete feature set is available.
    };

    const startTimer = window.setTimeout(() => {
      void analyzePhotoEntries(processingEntries, controller.signal, publishProgress)
        .then((nextRecords) => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          startTransition(() => {
            setState((current) => {
              const records = new Map(
                current.signature === analysisSignature ? current.records : EMPTY_RECORDS
              );
              nextRecords.forEach((record, path) => records.set(path, record));
              return {
                signature: analysisSignature,
                records,
                progress: {
                  completed: processingEntries.length,
                  total: processingEntries.length,
                  isAnalyzing: false,
                },
              };
            });
          });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            console.warn("Photo analysis stopped", error);
            setState((current) => ({
              signature: analysisSignature,
              records: current.signature === analysisSignature ? current.records : EMPTY_RECORDS,
              progress: {
                completed: 0,
                total: processingEntries.length,
                isAnalyzing: false,
              },
            }));
          }
        });
    }, 180);

    return () => {
      window.clearTimeout(startTimer);
      controller.abort();
    };
  }, [analysisSignature, enabled, processingEntries]);

  return { records: visibleState.records, progress: visibleState.progress };
}
