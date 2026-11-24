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
  scopePath?: string,
  priorityPaths: string[] = [],
  paused = false
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
    // Directory refreshes are allowed to return the same files in a different
    // order. The analysis is path-keyed, so order alone must not cancel and
    // restart an otherwise identical run.
    () =>
      analysisEntries
        .map((item) => item.key)
        .sort()
        .join("\u001f"),
    [analysisEntries]
  );
  const analysisEntriesRef = useRef(analysisEntries);
  const priorityPathsRef = useRef(priorityPaths);
  useEffect(() => {
    analysisEntriesRef.current = analysisEntries;
  }, [analysisEntries]);
  useEffect(() => {
    priorityPathsRef.current = priorityPaths;
  }, [priorityPaths]);
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
  const analysisEntryCount = analysisEntries.length;

  useEffect(() => {
    if (!scopePath) return;
    return () => usePhotoAnalysisProgress.getState().clear(scopePath);
  }, [scopePath]);

  useEffect(() => {
    if (!scopePath) return;

    const progressStore = usePhotoAnalysisProgress.getState();
    if (!enabled || analysisEntryCount === 0) {
      progressStore.setProgress(scopePath, INITIAL_PROGRESS);
      return;
    }

    const currentState = stateRef.current;
    if (currentState.signature === analysisSignature) {
      progressStore.setProgress(scopePath, currentState.progress);
      return;
    }

    progressStore.setProgress(scopePath, {
      completed: 0,
      total: analysisEntryCount,
      isAnalyzing: true,
      stage: "extracting-features",
      stageCompleted: 0,
      stageTotal: analysisEntryCount,
    });
  }, [analysisEntryCount, analysisSignature, enabled, scopePath]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const entriesForAnalysis = analysisEntriesRef.current;
    const currentState = stateRef.current;
    const existingRecords =
      currentState.signature === analysisSignature ? currentState.records : EMPTY_RECORDS;
    const completedBaseline = entriesForAnalysis.reduce(
      (count, item) => (existingRecords.has(item.entry.path) ? count + 1 : count),
      0
    );
    const entriesToProcess = entriesForAnalysis.filter(
      (item) => !existingRecords.has(item.entry.path)
    );

    if (!enabled || paused) {
      return () => controller.abort();
    }

    const fullAnalysisComplete =
      currentState.signature === analysisSignature &&
      !currentState.progress.isAnalyzing &&
      currentState.progress.completed === entriesForAnalysis.length &&
      currentState.progress.total === entriesForAnalysis.length;

    if (entriesToProcess.length === 0 || fullAnalysisComplete) {
      return () => controller.abort();
    }

    // Buffer partial records locally so TopBar progress updates every ~180ms
    // without re-rendering the entire 2,000-line FileList component 5x/sec.
    const bufferedRecords = new Map<string, PhotoAnalysisRecord>();
    let lastReactStateCommitAt = performance.now();
    const REACT_STATE_COMMIT_INTERVAL_MS = 1500;

    const publishProgress = (
      progress: PhotoAnalysisProgress,
      partialRecords: Map<string, PhotoAnalysisRecord>
    ) => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      const mergedStageCompleted =
        progress.stage === "extracting-features" || progress.stage === "estimating-focus"
          ? Math.min(entriesForAnalysis.length, completedBaseline + progress.stageCompleted)
          : progress.stageCompleted;
      const nextProgress: PhotoAnalysisProgress = {
        completed:
          progress.stage === "extracting-features" || progress.stage === "estimating-focus"
            ? mergedStageCompleted
            : entriesForAnalysis.length,
        total: entriesForAnalysis.length,
        isAnalyzing: true,
        stage: progress.stage,
        stageCompleted: mergedStageCompleted,
        stageTotal:
          progress.stage === "extracting-features" || progress.stage === "estimating-focus"
            ? entriesForAnalysis.length
            : progress.stageTotal,
      };

      // Update the TopBar progress banner immediately so heavy grid rendering
      // can never starve or freeze the visible progress bar.
      if (scopePath) {
        usePhotoAnalysisProgress.getState().setProgress(scopePath, nextProgress);
      }

      partialRecords.forEach((record, path) => bufferedRecords.set(path, record));
      const now = performance.now();
      const shouldCommitRecords =
        progress.stage !== "extracting-features" ||
        now - lastReactStateCommitAt >= REACT_STATE_COMMIT_INTERVAL_MS;

      if (!shouldCommitRecords) {
        return;
      }

      lastReactStateCommitAt = now;
      const batch = new Map(bufferedRecords);
      bufferedRecords.clear();
      startTransition(() => {
        setState((current) => {
          const records = new Map(
            current.signature === analysisSignature ? current.records : EMPTY_RECORDS
          );
          batch.forEach((record, path) => records.set(path, record));
          return {
            signature: analysisSignature,
            records,
            progress: nextProgress,
          };
        });
      });
    };

    const startDelayMs = 200;
    const startTimer = window.setTimeout(() => {
      void analyzePhotoEntries(
        entriesToProcess,
        controller.signal,
        publishProgress,
        () => priorityPathsRef.current
      )
        .then((nextRecords) => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          const doneProgress: PhotoAnalysisProgress = {
            completed: entriesForAnalysis.length,
            total: entriesForAnalysis.length,
            isAnalyzing: false,
            stage: "done",
            stageCompleted: entriesForAnalysis.length,
            stageTotal: entriesForAnalysis.length,
          };
          if (scopePath) {
            usePhotoAnalysisProgress.getState().setProgress(scopePath, doneProgress);
          }
          startTransition(() => {
            setState((current) => {
              const records = new Map(
                current.signature === analysisSignature ? current.records : EMPTY_RECORDS
              );
              nextRecords.forEach((record, path) => records.set(path, record));
              return {
                signature: analysisSignature,
                records,
                progress: doneProgress,
              };
            });
          });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            console.warn("Photo analysis stopped", error);
            const failedProgress: PhotoAnalysisProgress = {
              completed: completedBaseline,
              total: entriesForAnalysis.length,
              isAnalyzing: false,
              stage: completedBaseline > 0 ? "done" : "extracting-features",
              stageCompleted: completedBaseline,
              stageTotal: entriesForAnalysis.length,
            };
            if (scopePath) {
              usePhotoAnalysisProgress.getState().setProgress(scopePath, failedProgress);
            }
            setState((current) => ({
              signature: analysisSignature,
              records: current.signature === analysisSignature ? current.records : EMPTY_RECORDS,
              progress: failedProgress,
            }));
          }
        });
    }, startDelayMs);

    return () => {
      window.clearTimeout(startTimer);
      controller.abort();
    };
  }, [analysisSignature, enabled, paused, scopePath]);

  return { records: visibleState.records, progress: visibleState.progress };
}
