import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Landmark,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import { useExhibitLabelDialog } from "@/stores/exhibitLabelDialog";
import { buildFileThumbnailUrl } from "@/lib/iconCache";
import { invalidateCache } from "@/lib/entriesCache";
import {
  DEFAULT_EXHIBIT_NAMING_OPTIONS,
  formatExhibitFilename,
  type ExhibitNamingOptions,
  type ParsedExhibitEntry,
} from "@/lib/exhibitLabelNaming";

interface ExhibitLabelGroup {
  labelId: string;
  labelPath: string;
  labelName: string;
  capturedAt: number | null;
  rawText: string;
  confidence: number;
  isSharedCard: boolean;
  primaryEntry: ParsedExhibitEntry;
  candidateEntries: ParsedExhibitEntry[];
}

interface ExhibitPhotoProposal {
  path: string;
  fileName: string;
  extension: string;
  cameraStem: string;
  alreadyRenamed: boolean;
  capturedAt: number | null;
  modified: number | null;
  size: number;
  role: "label" | "artifact_with_label" | "artifact";
  status: "matched" | "uncertain" | "label_photo" | "already_renamed" | "unmatched";
  matchedLabelId: string | null;
  matchedEntryIndex: number;
  proposedEntry: ParsedExhibitEntry | null;
  proposedName: string | null;
  evidenceNote: string;
  timeDeltaSecs: number | null;
  companionFiles: string[];
  ocrSnippet: string;
}

interface ExhibitScanResult {
  scanId: number;
  directory: string;
  cancelled: boolean;
  totalPhotos: number;
  labels: ExhibitLabelGroup[];
  proposals: ExhibitPhotoProposal[];
}

interface ExhibitScanProgressEvent {
  scanId: number;
  phase: string;
  processed: number;
  total: number;
  labelsFound: number;
}

interface CompletedRenamePair {
  from: string;
  to: string;
}

interface ExhibitApplyResult {
  renamedPhotos: number;
  renamedCompanions: number;
  failed: string[];
  completedPairs: CompletedRenamePair[];
  manifestPath: string | null;
}

interface ExhibitUndoResult {
  restored: number;
  failed: string[];
}

type MatchDirection = "auto" | "label_before" | "label_after";
type ProposalFilterTab =
  | "all"
  | "matched"
  | "uncertain"
  | "label_photo"
  | "already_renamed"
  | "unmatched";

function notifyDirectoryUpdated(directory: string) {
  invalidateCache(directory);
  window.dispatchEvent(
    new CustomEvent("finder-tags-updated", {
      detail: { parentPath: directory, path: directory },
    })
  );
}

export function ExhibitLabelDialog() {
  const { t } = useTranslation();
  const { isOpen, directory, selectedEntries, close } = useExhibitLabelDialog();

  const [scopeSelectedOnly, setScopeSelectedOnly] = useState(false);
  const [matchDirection, setMatchDirection] = useState<MatchDirection>("auto");
  const [skipAlreadyRenamed, setSkipAlreadyRenamed] = useState(true);
  const [renameCompanions, setRenameCompanions] = useState(true);
  const [namingOptions, setNamingOptions] = useState<ExhibitNamingOptions>(
    DEFAULT_EXHIBIT_NAMING_OPTIONS
  );

  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ExhibitScanProgressEvent | null>(null);
  const [scanResult, setScanResult] = useState<ExhibitScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // User edits on detected labels & per-photo assignments/selections
  const [editedLabels, setEditedLabels] = useState<Record<string, ExhibitLabelGroup>>({});
  const [photoAssignments, setPhotoAssignments] = useState<
    Record<string, { labelId: string | null; entryIndex: number }>
  >({});
  const [checkedPaths, setCheckedPaths] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<ProposalFilterTab>("all");
  const [expandedLabelIds, setExpandedLabelIds] = useState<Record<string, boolean>>({});
  const [inspectingPair, setInspectingPair] = useState<{
    photo: ExhibitPhotoProposal;
    label: ExhibitLabelGroup | null;
  } | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ExhibitApplyResult | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoDoneCount, setUndoDoneCount] = useState<number | null>(null);

  const activeScanRef = useRef(0);

  const runScan = useCallback(
    async (opts?: {
      dir?: string;
      selected?: string[];
      direction?: MatchDirection;
      skipRenamed?: boolean;
    }) => {
      const targetDir = opts?.dir ?? directory;
      if (!targetDir) return;
      const selectedPaths =
        opts?.selected ?? (scopeSelectedOnly ? selectedEntries.map((e) => e.path) : []);
      const direction = opts?.direction ?? matchDirection;
      const skipRenamed = opts?.skipRenamed ?? skipAlreadyRenamed;

      activeScanRef.current += 1;
      const token = activeScanRef.current;

      setScanning(true);
      setScanError(null);
      setApplyResult(null);
      setUndoDoneCount(null);
      setProgress(null);

      try {
        const res = await invoke<ExhibitScanResult>("scan_exhibit_labels", {
          request: {
            directory: targetDir,
            selectedPaths,
            matchDirection: direction,
            skipAlreadyRenamed: skipRenamed,
          },
        });
        if (activeScanRef.current !== token) return;
        setScanResult(res);

        const labelMap: Record<string, ExhibitLabelGroup> = {};
        for (const lbl of res.labels) {
          labelMap[lbl.labelId] = lbl;
        }
        setEditedLabels(labelMap);

        const assignMap: Record<string, { labelId: string | null; entryIndex: number }> = {};
        const checkMap: Record<string, boolean> = {};
        for (const p of res.proposals) {
          assignMap[p.path] = {
            labelId: p.matchedLabelId,
            entryIndex: p.matchedEntryIndex,
          };
          // Strictly follow SKILL.md: auto-check ONLY high-confidence single-artifact matches.
          // Uncertain / shared-card / label_photo / already_renamed stay unchecked until verified.
          checkMap[p.path] = p.status === "matched" && Boolean(p.proposedName);
        }
        setPhotoAssignments(assignMap);
        setCheckedPaths(checkMap);
      } catch (err) {
        if (activeScanRef.current === token) {
          setScanError(String(err));
        }
      } finally {
        if (activeScanRef.current === token) {
          setScanning(false);
        }
      }
    },
    [directory, matchDirection, scopeSelectedOnly, selectedEntries, skipAlreadyRenamed]
  );

  // Listen for live progress updates from Rust Vision OCR
  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | undefined;
    void listen<ExhibitScanProgressEvent>("exhibit-label-progress", (event) => {
      setProgress(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
    };
  }, [isOpen]);

  // Reset & auto-start scan when dialog opens for a new folder/selection
  useEffect(() => {
    if (!isOpen || !directory) return;
    const hasSelectedPhotos = selectedEntries.length > 0;
    const timer = window.setTimeout(() => {
      setScopeSelectedOnly(hasSelectedPhotos);
      setActiveTab("all");
      setInspectingPair(null);
      setScanResult(null);
      void runScan({
        dir: directory,
        selected: hasSelectedPhotos ? selectedEntries.map((e) => e.path) : [],
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      void invoke("cancel_exhibit_label_scan").catch(() => undefined);
    };
    // Intentionally triggered only on modal open / target change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, directory, selectedEntries]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (inspectingPair) {
          setInspectingPair(null);
        } else if (!applying) {
          void invoke("cancel_exhibit_label_scan").catch(() => undefined);
          close();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applying, close, inspectingPair, isOpen]);

  const labelList = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.labels.map((l) => editedLabels[l.labelId] ?? l);
  }, [editedLabels, scanResult]);

  const resolveProposalTarget = useCallback(
    (
      proposal: ExhibitPhotoProposal
    ): {
      label: ExhibitLabelGroup | null;
      entry: ParsedExhibitEntry | null;
      targetName: string | null;
    } => {
      const assign = photoAssignments[proposal.path];
      const labelId = assign !== undefined ? assign.labelId : proposal.matchedLabelId;
      const entryIndex = assign !== undefined ? assign.entryIndex : proposal.matchedEntryIndex;
      const label = labelId ? (editedLabels[labelId] ?? null) : null;
      const entry = label
        ? (label.candidateEntries[entryIndex] ?? label.primaryEntry)
        : proposal.proposedEntry;
      const targetName = formatExhibitFilename(
        entry,
        proposal.cameraStem,
        proposal.extension,
        namingOptions
      );
      return { label, entry, targetName };
    },
    [editedLabels, namingOptions, photoAssignments]
  );

  const counts = useMemo(() => {
    const base = {
      all: 0,
      matched: 0,
      uncertain: 0,
      label_photo: 0,
      already_renamed: 0,
      unmatched: 0,
    };
    if (!scanResult) return base;
    base.all = scanResult.proposals.length;
    for (const p of scanResult.proposals) {
      base[p.status] += 1;
    }
    return base;
  }, [scanResult]);

  const visibleProposals = useMemo(() => {
    if (!scanResult) return [];
    if (activeTab === "all") return scanResult.proposals;
    return scanResult.proposals.filter((p) => p.status === activeTab);
  }, [activeTab, scanResult]);

  const confirmedSummary = useMemo(() => {
    if (!scanResult)
      return {
        photos: 0,
        companions: 0,
        items: [] as Array<{ sourcePath: string; targetName: string }>,
      };
    const items: Array<{ sourcePath: string; targetName: string }> = [];
    let companions = 0;
    for (const p of scanResult.proposals) {
      if (!checkedPaths[p.path]) continue;
      const { targetName } = resolveProposalTarget(p);
      if (!targetName || targetName === p.fileName) continue;
      items.push({ sourcePath: p.path, targetName });
      if (renameCompanions) companions += p.companionFiles.length;
    }
    return { photos: items.length, companions, items };
  }, [checkedPaths, renameCompanions, resolveProposalTarget, scanResult]);

  if (!isOpen) return null;

  const updateLabelField = (
    labelId: string,
    field: keyof ParsedExhibitEntry,
    value: string,
    candidateIndex = 0
  ) => {
    setEditedLabels((prev) => {
      const current = prev[labelId];
      if (!current) return prev;
      const nextCandidates =
        current.candidateEntries.length > 0
          ? current.candidateEntries.map((item, idx) =>
              idx === candidateIndex ? { ...item, [field]: value } : item
            )
          : [{ ...current.primaryEntry, [field]: value }];
      const nextPrimary =
        candidateIndex === 0 ? { ...current.primaryEntry, [field]: value } : current.primaryEntry;
      return {
        ...prev,
        [labelId]: {
          ...current,
          primaryEntry: nextPrimary,
          candidateEntries: nextCandidates,
        },
      };
    });
  };

  const handleApply = async () => {
    if (confirmedSummary.items.length === 0 || applying) return;
    setApplying(true);
    setApplyResult(null);
    setUndoDoneCount(null);
    try {
      const res = await invoke<ExhibitApplyResult>("apply_exhibit_label_renames", {
        items: confirmedSummary.items,
        renameCompanions,
      });
      setApplyResult(res);
      if (res.renamedPhotos > 0) {
        notifyDirectoryUpdated(directory);
      }
    } catch (err) {
      setScanError(String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleUndo = async () => {
    if (!applyResult || applyResult.completedPairs.length === 0 || undoing) return;
    setUndoing(true);
    try {
      const res = await invoke<ExhibitUndoResult>("undo_exhibit_label_renames", {
        pairs: applyResult.completedPairs,
      });
      setUndoDoneCount(res.restored);
      notifyDirectoryUpdated(directory);
    } catch (err) {
      setScanError(String(err));
    } finally {
      setUndoing(false);
    }
  };

  const handleCancelScan = () => {
    void invoke("cancel_exhibit_label_scan").catch(() => undefined);
  };

  const handleSelectAllMatched = () => {
    if (!scanResult) return;
    const next: Record<string, boolean> = { ...checkedPaths };
    for (const p of scanResult.proposals) {
      const { targetName } = resolveProposalTarget(p);
      if ((p.status === "matched" || p.status === "uncertain") && targetName) {
        next[p.path] = p.status === "matched";
      }
    }
    setCheckedPaths(next);
  };

  const handleClearSelection = () => {
    setCheckedPaths({});
  };

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={t("exhibit_label.title")}
      onClick={() => {
        if (!applying) {
          handleCancelScan();
          close();
        }
      }}
    >
      <div
        className="bg-background border-border/80 flex h-[min(90vh,54rem)] w-[min(96vw,76rem)] flex-col overflow-hidden rounded-xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Landmark className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
            <h2 className="truncate text-sm font-semibold">{t("exhibit_label.title")}</h2>
            <span className="text-muted-foreground hidden truncate font-mono text-[11px] sm:inline">
              {directory}
            </span>
          </div>
          <button
            type="button"
            disabled={applying}
            onClick={() => {
              handleCancelScan();
              close();
            }}
            aria-label={t("common.cancel")}
            className="text-muted-foreground hover:text-foreground rounded-md p-1 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Config & Scan Control Bar */}
        <div className="border-border/60 bg-muted/25 flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-xs">
          {selectedEntries.length > 0 && (
            <div className="border-border/70 bg-background inline-flex overflow-hidden rounded-md border">
              <button
                type="button"
                disabled={scanning}
                onClick={() => setScopeSelectedOnly(true)}
                className={`px-2 py-1 text-[11px] ${
                  scopeSelectedOnly
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {t("exhibit_label.scope_selected", { count: selectedEntries.length })}
              </button>
              <button
                type="button"
                disabled={scanning}
                onClick={() => setScopeSelectedOnly(false)}
                className={`px-2 py-1 text-[11px] ${
                  !scopeSelectedOnly
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {t("exhibit_label.scope_folder")}
              </button>
            </div>
          )}

          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("exhibit_label.direction_label")}</span>
            <select
              disabled={scanning}
              value={matchDirection}
              onChange={(e) => setMatchDirection(e.target.value as MatchDirection)}
              className="bg-background border-border/70 h-7 rounded border px-2 text-[11px] outline-none"
            >
              <option value="auto">{t("exhibit_label.direction_auto")}</option>
              <option value="label_before">{t("exhibit_label.direction_before")}</option>
              <option value="label_after">{t("exhibit_label.direction_after")}</option>
            </select>
          </label>

          {/* Naming field toggles */}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground mr-0.5">{t("exhibit_label.fields_label")}</span>
            {(
              [
                ["includeEra", "exhibit_label.field_era"],
                ["includeProvenance", "exhibit_label.field_provenance"],
                ["includeCollection", "exhibit_label.field_collection"],
              ] as const
            ).map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                onClick={() => setNamingOptions((prev) => ({ ...prev, [key]: !prev[key] }))}
                aria-pressed={namingOptions[key]}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  namingOptions[key]
                    ? "border-primary/40 bg-primary/15 text-primary font-medium"
                    : "border-border/70 text-muted-foreground hover:bg-accent"
                }`}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>

          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={renameCompanions}
              onChange={(e) => setRenameCompanions(e.target.checked)}
              className="accent-primary"
            />
            <span>{t("exhibit_label.rename_companions")}</span>
          </label>

          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              disabled={scanning}
              checked={skipAlreadyRenamed}
              onChange={(e) => setSkipAlreadyRenamed(e.target.checked)}
              className="accent-primary"
            />
            <span>{t("exhibit_label.skip_renamed")}</span>
          </label>

          <div className="ml-auto flex items-center gap-2">
            {scanning ? (
              <button
                type="button"
                onClick={handleCancelScan}
                className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 rounded-md border px-2.5 py-1 text-[11px] font-medium"
              >
                {t("exhibit_label.stop_scan")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runScan()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium"
              >
                <Play className="h-3 w-3" aria-hidden="true" />
                {scanResult ? t("exhibit_label.rescan") : t("exhibit_label.start_scan")}
              </button>
            )}
          </div>
        </div>

        {/* Live Progress */}
        {scanning && (
          <div className="border-border/60 bg-primary/5 flex flex-col gap-1.5 border-b px-4 py-2.5 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium">
                <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" />
                <span>
                  {progress
                    ? t("exhibit_label.scanning_progress", {
                        done: progress.processed,
                        total: progress.total,
                        labels: progress.labelsFound,
                      })
                    : t("exhibit_label.scanning_init")}
                </span>
              </div>
              <span className="font-mono text-[11px] tabular-nums">{progressPct}%</span>
            </div>
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-all duration-150"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {scanError && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive border-b px-4 py-2 text-xs">
            {scanError}
          </div>
        )}

        {applyResult && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {undoDoneCount !== null
                  ? t("exhibit_label.undo_done", { count: undoDoneCount })
                  : t("exhibit_label.apply_done", {
                      photos: applyResult.renamedPhotos,
                      companions: applyResult.renamedCompanions,
                      failed: applyResult.failed.length,
                    })}
              </span>
            </div>
            {undoDoneCount === null && applyResult.completedPairs.length > 0 && (
              <button
                type="button"
                disabled={undoing}
                onClick={() => void handleUndo()}
                className="border-border/70 bg-background hover:bg-accent inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium"
              >
                {undoing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                {t("exhibit_label.undo_batch")}
              </button>
            )}
          </div>
        )}

        {/* Main Split Workbench: Left = Detected Labels Editor, Right = Artifact Proposals */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left Panel: Detected Exhibit Labels (Editable) */}
          <div className="border-border/60 flex w-80 shrink-0 flex-col overflow-hidden border-r lg:w-96">
            <div className="border-border/60 bg-muted/20 flex items-center justify-between border-b px-3 py-2 text-xs font-medium">
              <span className="inline-flex items-center gap-1.5">
                <Tag className="text-primary h-3.5 w-3.5" aria-hidden="true" />
                {t("exhibit_label.detected_labels", { count: labelList.length })}
              </span>
              <span className="text-muted-foreground text-[11px]">
                {t("exhibit_label.edit_hint")}
              </span>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
              {labelList.length === 0 ? (
                <div className="text-muted-foreground py-8 text-center text-xs">
                  {scanning ? t("exhibit_label.scanning_init") : t("exhibit_label.no_labels")}
                </div>
              ) : (
                labelList.map((label) => {
                  const rawOpen = Boolean(expandedLabelIds[label.labelId]);
                  const thumbUrl = buildFileThumbnailUrl(
                    label.labelPath,
                    null,
                    0,
                    256,
                    true,
                    false
                  );
                  return (
                    <div
                      key={label.labelId}
                      className="border-border/70 bg-muted/15 space-y-2 rounded-lg border p-2 text-xs"
                    >
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setInspectingPair({
                              photo: {
                                path: label.labelPath,
                                fileName: label.labelName,
                                extension: "",
                                cameraStem: "",
                                alreadyRenamed: false,
                                capturedAt: label.capturedAt,
                                modified: null,
                                size: 0,
                                role: "label",
                                status: "label_photo",
                                matchedLabelId: label.labelId,
                                matchedEntryIndex: 0,
                                proposedEntry: label.primaryEntry,
                                proposedName: null,
                                evidenceNote: "",
                                timeDeltaSecs: 0,
                                companionFiles: [],
                                ocrSnippet: "",
                              },
                              label,
                            })
                          }
                          title={t("exhibit_label.inspect_label")}
                          className="bg-muted relative h-14 w-16 shrink-0 overflow-hidden rounded border"
                        >
                          <img
                            src={thumbUrl}
                            alt={label.labelName}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-mono text-[11px] font-medium">
                              {label.labelName}
                            </span>
                            {label.isSharedCard && (
                              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                {t("exhibit_label.shared_card_badge")}
                              </span>
                            )}
                          </div>
                          <div className="text-muted-foreground mt-0.5 text-[10px]">
                            OCR {Math.round(label.confidence * 100)}%
                            {label.primaryEntry.accessionNumber
                              ? ` · #${label.primaryEntry.accessionNumber}`
                              : ""}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedLabelIds((prev) => ({
                                ...prev,
                                [label.labelId]: !prev[label.labelId],
                              }))
                            }
                            className="text-primary mt-1 inline-flex items-center gap-0.5 text-[10px] hover:underline"
                          >
                            {rawOpen ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            {t("exhibit_label.raw_ocr")}
                          </button>
                        </div>
                      </div>

                      {rawOpen && (
                        <pre className="bg-background/80 border-border/60 max-h-28 overflow-y-auto rounded border p-1.5 font-mono text-[10px] whitespace-pre-wrap">
                          {label.rawText || "—"}
                        </pre>
                      )}

                      {/* Editable Primary Fields */}
                      <div className="grid grid-cols-2 gap-1.5">
                        <input
                          type="text"
                          value={label.primaryEntry.era}
                          onChange={(e) => updateLabelField(label.labelId, "era", e.target.value)}
                          placeholder={t("exhibit_label.field_era")}
                          className="bg-background border-border/70 rounded border px-1.5 py-1 text-[11px] outline-none focus:ring-1"
                        />
                        <input
                          type="text"
                          value={label.primaryEntry.name}
                          onChange={(e) => updateLabelField(label.labelId, "name", e.target.value)}
                          placeholder={t("exhibit_label.field_name")}
                          className="bg-background border-border/70 rounded border px-1.5 py-1 text-[11px] font-medium outline-none focus:ring-1"
                        />
                        <input
                          type="text"
                          value={label.primaryEntry.provenance}
                          onChange={(e) =>
                            updateLabelField(label.labelId, "provenance", e.target.value)
                          }
                          placeholder={t("exhibit_label.field_provenance")}
                          className="bg-background border-border/70 rounded border px-1.5 py-1 text-[11px] outline-none focus:ring-1"
                        />
                        <input
                          type="text"
                          value={label.primaryEntry.collection}
                          onChange={(e) =>
                            updateLabelField(label.labelId, "collection", e.target.value)
                          }
                          placeholder={t("exhibit_label.field_collection")}
                          className="bg-background border-border/70 rounded border px-1.5 py-1 text-[11px] outline-none focus:ring-1"
                        />
                      </div>

                      {label.candidateEntries.length > 1 && (
                        <div className="space-y-1 pt-0.5">
                          <div className="text-muted-foreground text-[10px]">
                            {t("exhibit_label.shared_candidates")}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {label.candidateEntries.map((cand, idx) => (
                              <span
                                key={`${label.labelId}-cand-${idx}`}
                                className="bg-background border-border/60 rounded border px-1.5 py-0.5 text-[10px]"
                              >
                                {idx + 1}. {[cand.era, cand.name].filter(Boolean).join("-")}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Panel: Photo Proposals Table */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Filter Tabs */}
            <div className="border-border/60 bg-muted/15 flex flex-wrap items-center gap-1 border-b px-3 py-2 text-xs">
              {(
                [
                  ["all", "exhibit_label.tab_all"],
                  ["matched", "exhibit_label.tab_matched"],
                  ["uncertain", "exhibit_label.tab_uncertain"],
                  ["label_photo", "exhibit_label.tab_labels"],
                  ["already_renamed", "exhibit_label.tab_renamed"],
                  ["unmatched", "exhibit_label.tab_unmatched"],
                ] as Array<[ProposalFilterTab, string]>
              ).map(([tab, labelKey]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                    activeTab === tab
                      ? "bg-primary/15 text-primary font-medium"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {t(labelKey)} ({counts[tab]})
                </button>
              ))}
            </div>

            {/* Proposals Scroll Area */}
            <div className="divide-border/50 min-h-0 flex-1 divide-y overflow-y-auto">
              {visibleProposals.length === 0 ? (
                <div className="text-muted-foreground flex h-48 flex-col items-center justify-center gap-1 text-xs">
                  <Sparkles className="h-5 w-5 opacity-40" />
                  <span>
                    {scanning ? t("exhibit_label.scanning_init") : t("exhibit_label.empty_tab")}
                  </span>
                </div>
              ) : (
                visibleProposals.map((proposal) => {
                  const { label, targetName } = resolveProposalTarget(proposal);
                  const isChecked = Boolean(checkedPaths[proposal.path]);
                  const canCheck = Boolean(targetName && targetName !== proposal.fileName);
                  const photoThumb = buildFileThumbnailUrl(
                    proposal.path,
                    proposal.modified,
                    proposal.size,
                    192,
                    true,
                    false
                  );
                  const assign = photoAssignments[proposal.path];
                  const selectedLabelId =
                    assign !== undefined ? (assign.labelId ?? "") : (proposal.matchedLabelId ?? "");
                  const selectedEntryIdx =
                    assign !== undefined ? assign.entryIndex : proposal.matchedEntryIndex;

                  return (
                    <div
                      key={proposal.path}
                      className={`flex items-center gap-3 px-3 py-2 text-xs transition-colors ${
                        isChecked ? "bg-primary/[0.04]" : "hover:bg-muted/25"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canCheck || applying}
                        onChange={(e) =>
                          setCheckedPaths((prev) => ({
                            ...prev,
                            [proposal.path]: e.target.checked,
                          }))
                        }
                        aria-label={proposal.fileName}
                        className="accent-primary h-4 w-4 shrink-0"
                      />

                      <button
                        type="button"
                        onClick={() => setInspectingPair({ photo: proposal, label })}
                        title={t("exhibit_label.compare_visual")}
                        className="bg-muted group relative h-12 w-14 shrink-0 overflow-hidden rounded border"
                      >
                        <img
                          src={photoThumb}
                          alt={proposal.fileName}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
                          <Eye className="h-3.5 w-3.5 text-white" />
                        </span>
                      </button>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground truncate font-mono text-[11px]">
                            {proposal.fileName}
                          </span>
                          {proposal.status === "matched" && (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                              {t("exhibit_label.badge_matched")}
                            </span>
                          )}
                          {proposal.status === "uncertain" && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                              <AlertTriangle className="h-2.5 w-2.5" />
                              {t("exhibit_label.badge_uncertain")}
                            </span>
                          )}
                          {proposal.status === "label_photo" && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                              <FileText className="h-2.5 w-2.5" />
                              {t("exhibit_label.badge_label")}
                            </span>
                          )}
                          {proposal.status === "already_renamed" && (
                            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
                              {t("exhibit_label.badge_renamed")}
                            </span>
                          )}
                          {proposal.companionFiles.length > 0 && (
                            <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-mono text-[10px]">
                              +{proposal.companionFiles.map((f) => f.split(".").pop()).join(", ")}
                            </span>
                          )}
                        </div>

                        {targetName && proposal.status !== "already_renamed" ? (
                          <div className="text-foreground truncate font-medium" title={targetName}>
                            → {targetName}
                          </div>
                        ) : (
                          <div className="text-muted-foreground text-[11px]">
                            {proposal.evidenceNote}
                          </div>
                        )}

                        {targetName && (
                          <div className="text-muted-foreground truncate text-[10px]">
                            {proposal.evidenceNote}
                          </div>
                        )}
                      </div>

                      {/* Label Assignment Selector */}
                      {proposal.status !== "already_renamed" && labelList.length > 0 && (
                        <div className="flex shrink-0 flex-col gap-1">
                          <select
                            disabled={applying}
                            value={selectedLabelId}
                            onChange={(e) => {
                              const nextLabelId = e.target.value || null;
                              setPhotoAssignments((prev) => ({
                                ...prev,
                                [proposal.path]: { labelId: nextLabelId, entryIndex: 0 },
                              }));
                              if (nextLabelId) {
                                setCheckedPaths((prev) => ({ ...prev, [proposal.path]: true }));
                              } else {
                                setCheckedPaths((prev) => ({ ...prev, [proposal.path]: false }));
                              }
                            }}
                            aria-label={t("exhibit_label.assign_label")}
                            className="bg-background border-border/70 h-7 w-40 rounded border px-1.5 text-[11px] outline-none"
                          >
                            <option value="">{t("exhibit_label.unassigned")}</option>
                            {labelList.map((lbl) => (
                              <option key={lbl.labelId} value={lbl.labelId}>
                                {lbl.primaryEntry.name
                                  ? `${lbl.primaryEntry.era ? `${lbl.primaryEntry.era}-` : ""}${lbl.primaryEntry.name}`
                                  : lbl.labelName}
                              </option>
                            ))}
                          </select>

                          {label && label.candidateEntries.length > 1 && (
                            <select
                              disabled={applying}
                              value={selectedEntryIdx}
                              onChange={(e) => {
                                const idx = Number(e.target.value);
                                setPhotoAssignments((prev) => ({
                                  ...prev,
                                  [proposal.path]: { labelId: label.labelId, entryIndex: idx },
                                }));
                                setCheckedPaths((prev) => ({ ...prev, [proposal.path]: true }));
                              }}
                              aria-label={t("exhibit_label.select_candidate")}
                              className="bg-background h-6 w-40 rounded border border-amber-500/50 px-1.5 text-[10px] outline-none"
                            >
                              {label.candidateEntries.map((cand, idx) => (
                                <option key={idx} value={idx}>
                                  #{idx + 1} {[cand.era, cand.name].filter(Boolean).join("-")}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-border/60 bg-muted/20 flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">
              {t("exhibit_label.footer_selected", {
                photos: confirmedSummary.photos,
                companions: confirmedSummary.companions,
              })}
            </span>
            {scanResult && (
              <>
                <button
                  type="button"
                  onClick={handleSelectAllMatched}
                  className="text-primary text-[11px] hover:underline"
                >
                  {t("exhibit_label.check_matched")}
                </button>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="text-muted-foreground hover:text-foreground text-[11px] hover:underline"
                >
                  {t("exhibit_label.uncheck_all")}
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={applying}
              onClick={() => {
                handleCancelScan();
                close();
              }}
              className="text-muted-foreground hover:bg-accent rounded-md px-3 py-1.5"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={applying || scanning || confirmedSummary.photos === 0}
              onClick={() => void handleApply()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 font-medium disabled:opacity-50"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {applying
                ? t("exhibit_label.applying")
                : t("exhibit_label.apply_btn", { count: confirmedSummary.photos })}
            </button>
          </div>
        </div>
      </div>

      {/* Side-by-Side Visual Verification Overlay */}
      {inspectingPair && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setInspectingPair(null)}
        >
          <div
            className="bg-background border-border flex max-h-[90vh] w-[min(94vw,76rem)] flex-col overflow-hidden rounded-xl border shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-border/60 flex items-center justify-between border-b px-4 py-2.5 text-xs">
              <span className="font-medium">
                {t("exhibit_label.compare_title")} · {inspectingPair.photo.fileName}
              </span>
              <button
                type="button"
                onClick={() => setInspectingPair(null)}
                className="text-muted-foreground hover:text-foreground rounded p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-2">
              <div className="bg-muted/20 flex min-h-0 flex-col items-center justify-center overflow-hidden rounded-lg border p-2">
                <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                  {inspectingPair.photo.fileName}
                </div>
                <img
                  src={buildFileThumbnailUrl(
                    inspectingPair.photo.path,
                    inspectingPair.photo.modified,
                    inspectingPair.photo.size,
                    1600,
                    true,
                    false
                  )}
                  alt={inspectingPair.photo.fileName}
                  className="max-h-[70vh] max-w-full rounded object-contain"
                />
              </div>
              <div className="bg-muted/20 flex min-h-0 flex-col items-center justify-center overflow-hidden rounded-lg border p-2">
                {inspectingPair.label ? (
                  <>
                    <div className="text-muted-foreground mb-1 text-[11px] font-medium">
                      {t("exhibit_label.matched_plaque")}: {inspectingPair.label.labelName}
                    </div>
                    <img
                      src={buildFileThumbnailUrl(
                        inspectingPair.label.labelPath,
                        null,
                        0,
                        1600,
                        true,
                        false
                      )}
                      alt={inspectingPair.label.labelName}
                      className="max-h-[55vh] max-w-full rounded object-contain"
                    />
                    <pre className="bg-background/90 border-border/60 mt-2 max-h-28 w-full overflow-y-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
                      {inspectingPair.label.rawText || "—"}
                    </pre>
                  </>
                ) : (
                  <div className="text-muted-foreground text-xs">
                    {t("exhibit_label.no_matched_plaque")}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
