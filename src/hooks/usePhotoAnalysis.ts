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
  stage: "done",
  stageCompleted: 0,
  stageTotal: 0,
};

interface PhotoAnalysisState {
  signature: string;
  records: Map<string, PhotoAnalysisRecord>;
  progress: PhotoAnalysisProgress;
}

export function usePhotoAnalysis(
  entries: FileEntry[],
  enabled: boolean,
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

  const analysisEntries = useMemo(() => (enabled ? getPhotoAnalysisEntries(entries) : []), [entries, enabled]);
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
            stage: enabled && analysisEntries.length > 0 ? "extracting-features" : "done",
            stageCompleted: 0,
            stageTotal: analysisEntries.length,
          },
        };
  const {
    completed: visibleCompleted,
    total: visibleTotal,
    isAnalyzing: visibleIsAnalyzing,
    stage: visibleStage,
    stageCompleted: visibleStageCompleted,
    stageTotal: visibleStageTotal,
  } = visibleState.progress;

  useEffect(() => {
    if (!scopePath) return;

    const progressStore = usePhotoAnalysisProgress.getState();
    if (!enabled) {
      progressStore.setProgress(scopePath, INITIAL_PROGRESS);
    } else {
      progressStore.setProgress(scopePath, {
        completed: visibleCompleted,
        total: visibleTotal,
        isAnalyzing: visibleIsAnalyzing,
        stage: visibleStage,
        stageCompleted: visibleStageCompleted,
        stageTotal: visibleStageTotal,
      });
    }

    return () => progressStore.clear(scopePath);
  }, [
    analysisSignature,
    enabled,
    scopePath,
    visibleCompleted,
    visibleIsAnalyzing,
    visibleStage,
    visibleStageCompleted,
    visibleStageTotal,
    visibleTotal,
  ]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const currentState = stateRef.current;
    const existingRecords =
      currentState.signature === analysisSignature ? currentState.records : EMPTY_RECORDS;
    const completedBaseline = analysisEntries.reduce(
      (count, item) => (existingRecords.has(item.entry.path) ? count + 1 : count),
      0
    );
    const entriesToProcess = analysisEntries.filter((item) => !existingRecords.has(item.entry.path));

    if (!enabled) {
      return () => controller.abort();
    }

    const fullAnalysisComplete =
      currentState.signature === analysisSignature &&
      !currentState.progress.isAnalyzing &&
      currentState.progress.completed === analysisEntries.length &&
      currentState.progress.total === analysisEntries.length;

    if (entriesToProcess.length === 0 || fullAnalysisComplete) {
      return () => controller.abort();
    }

    const publishProgress = (
      progress: PhotoAnalysisProgress,
      partialRecords: Map<string, PhotoAnalysisRecord>
    ) => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setState((current) => {
        const records = new Map(
          current.signature === analysisSignature ? current.records : EMPTY_RECORDS
        );
        partialRecords.forEach((record, path) => records.set(path, record));
        const mergedStageCompleted =
          progress.stage === "extracting-features" || progress.stage === "estimating-focus"
            ? Math.min(analysisEntries.length, completedBaseline + progress.stageCompleted)
            : progress.stageCompleted;
        return {
          signature: analysisSignature,
          records,
          progress: {
            completed:
              progress.stage === "extracting-features" || progress.stage === "estimating-focus"
                ? mergedStageCompleted
                : analysisEntries.length,
            total: analysisEntries.length,
            isAnalyzing: true,
            stage: progress.stage,
            stageCompleted: mergedStageCompleted,
            stageTotal:
              progress.stage === "extracting-features" || progress.stage === "estimating-focus"
                ? analysisEntries.length
                : progress.stageTotal,
          },
        };
      });
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
                  completed: analysisEntries.length,
                  total: analysisEntries.length,
                  isAnalyzing: false,
                  stage: "done",
                  stageCompleted: analysisEntries.length,
                  stageTotal: analysisEntries.length,
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
                completed: completedBaseline,
                total: analysisEntries.length,
                isAnalyzing: false,
                stage: completedBaseline > 0 ? "done" : "extracting-features",
                stageCompleted: completedBaseline,
                stageTotal: analysisEntries.length,
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
    analysisEntries,
    analysisEntries.length,
    analysisSignature,
    enabled,
  ]);

  return { records: visibleState.records, progress: visibleState.progress };
}
