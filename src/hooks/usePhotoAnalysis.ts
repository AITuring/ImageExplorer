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
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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
  const processingSignature = useMemo(
    () => processingEntries.map((item) => item.key).join("\u001f"),
    [processingEntries]
  );
  const processingEntriesRef = useRef(processingEntries);
  useEffect(() => {
    processingEntriesRef.current = processingEntries;
  }, [processingEntries]);
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
    const entriesToProcess = processingEntriesRef.current;

    if (!enabled || entriesToProcess.length === 0) {
      return () => controller.abort();
    }

    const currentState = stateRef.current;
    const hasCurrentState = currentState.signature === analysisSignature;
    const priorityAlreadyAvailable =
      paused &&
      priorityPath !== undefined &&
      hasCurrentState &&
      currentState.records.has(priorityPath);
    const fullAnalysisComplete =
      !paused &&
      hasCurrentState &&
      !currentState.progress.isAnalyzing &&
      currentState.progress.completed === analysisEntries.length &&
      currentState.progress.total === analysisEntries.length;

    // Opening Quick Look, resizing it, or receiving an equivalent entries
    // array must not restart analysis for the same file versions. Existing
    // results remain valid until path, modification time, or file size changes.
    if (priorityAlreadyAvailable || fullAnalysisComplete) {
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
            total: entriesToProcess.length,
            isAnalyzing: completed < entriesToProcess.length,
          },
        };
      });
      // Publish partial regions so visible bursts get focus feedback while
      // the rest of a large folder is still being decoded. Group colors are
      // assigned once the complete feature set is available.
    };

    const startTimer = window.setTimeout(() => {
      void analyzePhotoEntries(entriesToProcess, controller.signal, publishProgress)
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
                  completed: entriesToProcess.length,
                  total: entriesToProcess.length,
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
                total: entriesToProcess.length,
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
  }, [
    analysisEntries.length,
    analysisSignature,
    enabled,
    paused,
    priorityPath,
    processingSignature,
  ]);

  return { records: visibleState.records, progress: visibleState.progress };
}
