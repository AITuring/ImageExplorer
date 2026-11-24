import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  FolderInput,
  GitMerge,
  ImageOff,
  Loader2,
  Play,
  RotateCcw,
  User,
  Users,
  X,
} from "lucide-react";
import { usePeopleClusterDialog } from "@/stores/peopleClusterDialog";
import { buildFileThumbnailUrl } from "@/lib/iconCache";
import { invalidateCache } from "@/lib/entriesCache";
import {
  buildPeopleOrganizeAssignments,
  computeMergedPeopleView,
  type MultiPersonMode,
  type PeoplePhotoLike,
  type PersonClusterLike,
} from "@/lib/peopleOrganization";

interface PeopleScanResult {
  scanId: number;
  directory: string;
  cancelled: boolean;
  threshold: number;
  totalPhotos: number;
  totalFaces: number;
  people: PersonClusterLike[];
  groupPhotoPaths: string[];
  noFacePhotoPaths: string[];
  photos: PeoplePhotoLike[];
}

interface PeopleScanProgressEvent {
  scanId: number;
  processed: number;
  total: number;
  facesFound: number;
}

interface CompletedOrganizeOp {
  from: string;
  to: string;
  isCopy: boolean;
}

interface PeopleOrganizeResult {
  organizedPhotos: number;
  organizedCompanions: number;
  createdFolders: string[];
  failed: string[];
  completedOps: CompletedOrganizeOp[];
}

interface PeopleUndoResult {
  restored: number;
  failed: string[];
}

type ActiveSelection = "all" | "group" | "no_face" | string;

function notifyDirectoryUpdated(directory: string) {
  invalidateCache(directory);
  window.dispatchEvent(
    new CustomEvent("finder-tags-updated", {
      detail: { parentPath: directory, path: directory },
    })
  );
}

export function PeopleClusterDialog() {
  const { t } = useTranslation();
  const { isOpen, directory, selectedEntries, close } = usePeopleClusterDialog();

  const [scopeSelectedOnly, setScopeSelectedOnly] = useState(false);
  const [threshold, setThreshold] = useState(0.64);
  const [organizeMode, setOrganizeMode] = useState<"move" | "copy">("move");
  const [multiPersonMode, setMultiPersonMode] = useState<MultiPersonMode>("group_folder");
  const [includeCompanions, setIncludeCompanions] = useState(true);
  const [includeGroupPhotos, setIncludeGroupPhotos] = useState(true);
  const [includeNoFacePhotos, setIncludeNoFacePhotos] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<PeopleScanProgressEvent | null>(null);
  const [scanResult, setScanResult] = useState<PeopleScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [personNames, setPersonNames] = useState<Record<string, string>>({});
  const [mergedInto, setMergedInto] = useState<Record<string, string>>({});
  const [enabledPersonIds, setEnabledPersonIds] = useState<Record<string, boolean>>({});
  const [activeBucket, setActiveBucket] = useState<ActiveSelection>("all");
  const [previewPhoto, setPreviewPhoto] = useState<PeoplePhotoLike | null>(null);

  const [organizing, setOrganizing] = useState(false);
  const [organizeResult, setOrganizeResult] = useState<PeopleOrganizeResult | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoRestored, setUndoRestored] = useState<number | null>(null);

  const scanTokenRef = useRef(0);

  const initClusterState = useCallback((res: PeopleScanResult) => {
    const names: Record<string, string> = {};
    const enabled: Record<string, boolean> = {};
    for (const p of res.people) {
      names[p.personId] = p.defaultName;
      enabled[p.personId] = true;
    }
    setPersonNames(names);
    setMergedInto({});
    setEnabledPersonIds(enabled);
    setActiveBucket(res.people.length > 0 ? res.people[0].personId : "all");
  }, []);

  const runScan = useCallback(
    async (opts?: { dir?: string; selected?: string[]; sim?: number }) => {
      const targetDir = opts?.dir ?? directory;
      if (!targetDir) return;
      const selectedPaths =
        opts?.selected ?? (scopeSelectedOnly ? selectedEntries.map((e) => e.path) : []);
      const sim = opts?.sim ?? threshold;

      scanTokenRef.current += 1;
      const token = scanTokenRef.current;

      setScanning(true);
      setError(null);
      setProgress(null);
      setOrganizeResult(null);
      setUndoRestored(null);

      try {
        const res = await invoke<PeopleScanResult>("scan_people_clusters", {
          request: {
            directory: targetDir,
            selectedPaths,
            threshold: sim,
          },
        });
        if (scanTokenRef.current !== token) return;
        setScanResult(res);
        initClusterState(res);
      } catch (err) {
        if (scanTokenRef.current === token) {
          setError(String(err));
        }
      } finally {
        if (scanTokenRef.current === token) {
          setScanning(false);
        }
      }
    },
    [directory, initClusterState, scopeSelectedOnly, selectedEntries, threshold]
  );

  // Instant re-clustering when threshold slider moves (zero Vision re-scan!)
  const handleThresholdChange = async (nextThreshold: number) => {
    setThreshold(nextThreshold);
    if (!scanResult || scanning) return;
    try {
      const updated = await invoke<PeopleScanResult>("recluster_people", {
        scanId: scanResult.scanId,
        threshold: nextThreshold,
      });
      setScanResult(updated);
      initClusterState(updated);
    } catch {
      // ignore if session expired
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | undefined;
    void listen<PeopleScanProgressEvent>("people-cluster-progress", (event) => {
      setProgress(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !directory) return;
    const hasSelection = selectedEntries.length > 0;
    const timer = window.setTimeout(() => {
      setScopeSelectedOnly(hasSelection);
      setPreviewPhoto(null);
      setScanResult(null);
      void runScan({
        dir: directory,
        selected: hasSelection ? selectedEntries.map((e) => e.path) : [],
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      void invoke("cancel_people_scan").catch(() => undefined);
    };
    // Intentionally triggered only on dialog open / target change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, directory, selectedEntries]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (previewPhoto) {
          setPreviewPhoto(null);
        } else if (!organizing) {
          void invoke("cancel_people_scan").catch(() => undefined);
          close();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, isOpen, organizing, previewPhoto]);

  const { mergedPeople, groupPhotos, noFacePhotos, effectivePhotos } = useMemo(() => {
    if (!scanResult) {
      return { mergedPeople: [], groupPhotos: [], noFacePhotos: [], effectivePhotos: [] };
    }
    return computeMergedPeopleView(scanResult.people, scanResult.photos, personNames, mergedInto);
  }, [mergedInto, personNames, scanResult]);

  const photoByPath = useMemo(() => {
    const map = new Map<string, PeoplePhotoLike>();
    for (const p of effectivePhotos) {
      map.set(p.path, p);
    }
    return map;
  }, [effectivePhotos]);

  const organizePlan = useMemo(() => {
    if (!scanResult) return { assignments: [], folderCount: 0, companionCount: 0 };
    return buildPeopleOrganizeAssignments({
      people: scanResult.people,
      photos: scanResult.photos,
      personNames,
      mergedInto,
      enabledPersonIds,
      multiPersonMode,
      includeGroupPhotos,
      groupFolderName: t("people_cluster.group_folder_name"),
      includeNoFacePhotos,
      noFaceFolderName: t("people_cluster.no_face_folder_name"),
    });
  }, [
    enabledPersonIds,
    includeGroupPhotos,
    includeNoFacePhotos,
    mergedInto,
    multiPersonMode,
    personNames,
    scanResult,
    t,
  ]);

  const visiblePhotos = useMemo(() => {
    if (!scanResult) return [];
    if (activeBucket === "all") return effectivePhotos;
    if (activeBucket === "group") return groupPhotos;
    if (activeBucket === "no_face") return noFacePhotos;
    const person = mergedPeople.find((p) => p.personId === activeBucket);
    if (!person) return [];
    return person.photoPaths
      .map((path) => photoByPath.get(path))
      .filter((item): item is PeoplePhotoLike => Boolean(item));
  }, [
    activeBucket,
    effectivePhotos,
    groupPhotos,
    mergedPeople,
    noFacePhotos,
    photoByPath,
    scanResult,
  ]);

  if (!isOpen) return null;

  const handleOrganize = async () => {
    if (organizePlan.assignments.length === 0 || organizing) return;
    setOrganizing(true);
    setError(null);
    setOrganizeResult(null);
    setUndoRestored(null);
    try {
      // Duplicate-to-all requires copying multi-person photos cleanly; if user chose move + duplicate_to_all,
      // backend copy mode ensures a photo isn't moved away before being copied to the 2nd person's folder.
      const effectiveMode = multiPersonMode === "duplicate_to_all" ? "copy" : organizeMode;
      const res = await invoke<PeopleOrganizeResult>("organize_people_photos", {
        request: {
          directory,
          assignments: organizePlan.assignments.map((a) => ({
            sourcePath: a.sourcePath,
            targetFolderName: a.targetFolderName,
          })),
          mode: effectiveMode,
          includeCompanions,
        },
      });
      setOrganizeResult(res);
      if (res.organizedPhotos > 0) {
        notifyDirectoryUpdated(directory);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setOrganizing(false);
    }
  };

  const handleUndo = async () => {
    if (!organizeResult || organizeResult.completedOps.length === 0 || undoing) return;
    setUndoing(true);
    try {
      const res = await invoke<PeopleUndoResult>("undo_people_organization", {
        ops: organizeResult.completedOps,
      });
      setUndoRestored(res.restored);
      notifyDirectoryUpdated(directory);
    } catch (err) {
      setError(String(err));
    } finally {
      setUndoing(false);
    }
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
      aria-label={t("people_cluster.title")}
      onClick={() => {
        if (!organizing) {
          void invoke("cancel_people_scan").catch(() => undefined);
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
            <Users className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
            <h2 className="truncate text-sm font-semibold">{t("people_cluster.title")}</h2>
            <span className="text-muted-foreground hidden truncate font-mono text-[11px] sm:inline">
              {directory}
            </span>
          </div>
          <button
            type="button"
            disabled={organizing}
            onClick={() => {
              void invoke("cancel_people_scan").catch(() => undefined);
              close();
            }}
            aria-label={t("common.cancel")}
            className="text-muted-foreground hover:text-foreground rounded-md p-1 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Controls Bar */}
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
                {t("people_cluster.scope_selected", { count: selectedEntries.length })}
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
                {t("people_cluster.scope_folder")}
              </button>
            </div>
          )}

          {/* Real-time Similarity Threshold Slider */}
          <label className="inline-flex items-center gap-2">
            <span className="text-muted-foreground text-[11px]">
              {t("people_cluster.sensitivity")}
            </span>
            <input
              type="range"
              min={0.52}
              max={0.8}
              step={0.02}
              disabled={scanning || organizing}
              value={threshold}
              onChange={(e) => void handleThresholdChange(Number(e.target.value))}
              className="accent-primary w-24"
            />
            <span className="text-muted-foreground w-10 font-mono text-[11px] tabular-nums">
              {Math.round(threshold * 100)}%
            </span>
          </label>

          {/* Move vs Copy */}
          <div className="border-border/70 bg-background inline-flex overflow-hidden rounded-md border">
            <button
              type="button"
              disabled={organizing}
              onClick={() => setOrganizeMode("move")}
              className={`px-2 py-1 text-[11px] ${
                organizeMode === "move"
                  ? "bg-primary/15 text-primary font-medium"
                  : "text-muted-foreground"
              }`}
            >
              {t("people_cluster.mode_move")}
            </button>
            <button
              type="button"
              disabled={organizing}
              onClick={() => setOrganizeMode("copy")}
              className={`px-2 py-1 text-[11px] ${
                organizeMode === "copy"
                  ? "bg-primary/15 text-primary font-medium"
                  : "text-muted-foreground"
              }`}
            >
              {t("people_cluster.mode_copy")}
            </button>
          </div>

          {/* Multi-person policy */}
          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground text-[11px]">
              {t("people_cluster.multi_label")}
            </span>
            <select
              disabled={organizing}
              value={multiPersonMode}
              onChange={(e) => setMultiPersonMode(e.target.value as MultiPersonMode)}
              className="bg-background border-border/70 h-7 rounded border px-2 text-[11px] outline-none"
            >
              <option value="group_folder">{t("people_cluster.multi_group_folder")}</option>
              <option value="primary_person">{t("people_cluster.multi_primary")}</option>
              <option value="duplicate_to_all">{t("people_cluster.multi_copy_all")}</option>
            </select>
          </label>

          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={includeCompanions}
              onChange={(e) => setIncludeCompanions(e.target.checked)}
              className="accent-primary"
            />
            <span>{t("people_cluster.include_companions")}</span>
          </label>

          <div className="ml-auto flex items-center gap-2">
            {scanning ? (
              <button
                type="button"
                onClick={() => void invoke("cancel_people_scan").catch(() => undefined)}
                className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 rounded-md border px-2.5 py-1 text-[11px] font-medium"
              >
                {t("people_cluster.stop_scan")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runScan()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium"
              >
                <Play className="h-3 w-3" aria-hidden="true" />
                {scanResult ? t("people_cluster.rescan") : t("people_cluster.start_scan")}
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
                    ? t("people_cluster.scanning_progress", {
                        done: progress.processed,
                        total: progress.total,
                        faces: progress.facesFound,
                      })
                    : t("people_cluster.scanning_init")}
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

        {error && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive border-b px-4 py-2 text-xs">
            {error}
          </div>
        )}

        {organizeResult && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {undoRestored !== null
                  ? t("people_cluster.undo_done", { count: undoRestored })
                  : t("people_cluster.organize_done", {
                      photos: organizeResult.organizedPhotos,
                      companions: organizeResult.organizedCompanions,
                      folders: organizeResult.createdFolders.length,
                    })}
              </span>
            </div>
            {undoRestored === null && organizeResult.completedOps.length > 0 && (
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
                {t("people_cluster.undo")}
              </button>
            )}
          </div>
        )}

        {/* Main Split: Left = People Clusters List, Right = Grouped Photos Grid */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left People Sidebar */}
          <div className="border-border/60 flex w-72 shrink-0 flex-col overflow-hidden border-r lg:w-80">
            <div className="border-border/60 bg-muted/20 flex items-center justify-between border-b px-3 py-2 text-xs font-medium">
              <span>{t("people_cluster.detected_people", { count: mergedPeople.length })}</span>
              {Object.keys(mergedInto).length > 0 && (
                <button
                  type="button"
                  onClick={() => setMergedInto({})}
                  className="text-primary text-[11px] hover:underline"
                >
                  {t("people_cluster.reset_merges")}
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 text-xs">
              <button
                type="button"
                onClick={() => setActiveBucket("all")}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors ${
                  activeBucket === "all"
                    ? "bg-primary/15 text-primary font-medium"
                    : "hover:bg-accent/60"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <Users className="h-4 w-4 shrink-0" />
                  {t("people_cluster.all_photos")}
                </span>
                <span className="text-muted-foreground tabular-nums">{effectivePhotos.length}</span>
              </button>

              {mergedPeople.map((person) => {
                const isSelected = activeBucket === person.personId;
                const otherPeople = mergedPeople.filter((p) => p.personId !== person.personId);
                return (
                  <div
                    key={person.personId}
                    onClick={() => setActiveBucket(person.personId)}
                    className={`cursor-pointer space-y-1.5 rounded-lg border p-2 transition-colors ${
                      isSelected
                        ? "border-primary/40 bg-primary/10"
                        : "border-border/60 bg-muted/15 hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(enabledPersonIds[person.personId])}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setEnabledPersonIds((prev) => ({
                            ...prev,
                            [person.personId]: e.target.checked,
                          }))
                        }
                        aria-label={person.name}
                        className="accent-primary h-3.5 w-3.5 shrink-0"
                      />
                      <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border">
                        {person.avatarDataUrl ? (
                          <img
                            src={person.avatarDataUrl}
                            alt={person.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <User className="text-muted-foreground h-5 w-5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <input
                          type="text"
                          value={personNames[person.personId] ?? person.name}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setPersonNames((prev) => ({
                              ...prev,
                              [person.personId]: e.target.value,
                            }))
                          }
                          aria-label={t("people_cluster.rename_person")}
                          className="bg-background/80 border-border/60 w-full rounded border px-1.5 py-0.5 text-xs font-medium outline-none focus:ring-1"
                        />
                        <div className="text-muted-foreground mt-0.5 text-[10px]">
                          {t("people_cluster.person_count", {
                            total: person.photoPaths.length,
                            solo: person.soloPhotoPaths.length,
                          })}
                        </div>
                      </div>
                    </div>

                    {otherPeople.length > 0 && (
                      <div
                        className="flex items-center gap-1 pl-5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <GitMerge className="text-muted-foreground h-3 w-3 shrink-0" />
                        <select
                          value=""
                          onChange={(e) => {
                            const targetId = e.target.value;
                            if (!targetId) return;
                            setMergedInto((prev) => ({ ...prev, [person.personId]: targetId }));
                            if (activeBucket === person.personId) {
                              setActiveBucket(targetId);
                            }
                          }}
                          aria-label={t("people_cluster.merge_into")}
                          className="bg-background border-border/60 text-muted-foreground h-6 flex-1 rounded border px-1.5 text-[10px] outline-none"
                        >
                          <option value="">{t("people_cluster.merge_into")}</option>
                          {otherPeople.map((target) => (
                            <option key={target.personId} value={target.personId}>
                              {target.name} ({target.photoPaths.length})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Group photos bucket */}
              {groupPhotos.length > 0 && (
                <div
                  onClick={() => setActiveBucket("group")}
                  className={`flex cursor-pointer items-center justify-between rounded-lg border px-2.5 py-2 transition-colors ${
                    activeBucket === "group"
                      ? "border-primary/40 bg-primary/10 font-medium"
                      : "border-border/60 bg-muted/15 hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {multiPersonMode === "group_folder" && (
                      <input
                        type="checkbox"
                        checked={includeGroupPhotos}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setIncludeGroupPhotos(e.target.checked)}
                        className="accent-primary h-3.5 w-3.5"
                      />
                    )}
                    <Users className="text-primary h-4 w-4 shrink-0" />
                    <span>{t("people_cluster.group_folder_name")}</span>
                  </div>
                  <span className="text-muted-foreground tabular-nums">{groupPhotos.length}</span>
                </div>
              )}

              {/* No-face photos bucket */}
              {noFacePhotos.length > 0 && (
                <div
                  onClick={() => setActiveBucket("no_face")}
                  className={`flex cursor-pointer items-center justify-between rounded-lg border px-2.5 py-2 transition-colors ${
                    activeBucket === "no_face"
                      ? "border-primary/40 bg-primary/10 font-medium"
                      : "border-border/60 bg-muted/15 hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeNoFacePhotos}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setIncludeNoFacePhotos(e.target.checked)}
                      className="accent-primary h-3.5 w-3.5"
                    />
                    <ImageOff className="text-muted-foreground h-4 w-4 shrink-0" />
                    <span>{t("people_cluster.no_face_folder_name")}</span>
                  </div>
                  <span className="text-muted-foreground tabular-nums">{noFacePhotos.length}</span>
                </div>
              )}
            </div>
          </div>

          {/* Right Photo Grid */}
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {visiblePhotos.length === 0 ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-xs">
                <Users className="h-6 w-6 opacity-40" />
                <span>
                  {scanning ? t("people_cluster.scanning_init") : t("people_cluster.empty")}
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {visiblePhotos.map((photo) => {
                  const thumb = buildFileThumbnailUrl(
                    photo.path,
                    photo.modified,
                    photo.size,
                    320,
                    true,
                    false
                  );
                  return (
                    <button
                      key={photo.path}
                      type="button"
                      onClick={() => setPreviewPhoto(photo)}
                      className="border-border/60 bg-muted/20 hover:border-primary/50 group flex flex-col overflow-hidden rounded-lg border text-left transition-colors"
                    >
                      <div className="bg-muted relative aspect-square w-full overflow-hidden">
                        <img
                          src={thumb}
                          alt={photo.fileName}
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          loading="lazy"
                        />
                        {photo.companionFiles.length > 0 && (
                          <span className="bg-background/85 text-foreground absolute top-1.5 right-1.5 rounded px-1 py-0.5 font-mono text-[9px] backdrop-blur-xs">
                            +{photo.companionFiles.length}
                          </span>
                        )}
                      </div>
                      <div className="truncate px-2 py-1.5 font-mono text-[10px]">
                        {photo.fileName}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-border/60 bg-muted/20 flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs">
          <div className="text-muted-foreground">
            {t("people_cluster.footer_summary", {
              photos: organizePlan.assignments.length,
              companions: includeCompanions ? organizePlan.companionCount : 0,
              folders: organizePlan.folderCount,
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={organizing}
              onClick={() => {
                void invoke("cancel_people_scan").catch(() => undefined);
                close();
              }}
              className="text-muted-foreground hover:bg-accent rounded-md px-3 py-1.5"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={organizing || scanning || organizePlan.assignments.length === 0}
              onClick={() => void handleOrganize()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 font-medium disabled:opacity-50"
            >
              {organizing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {organizing
                ? t("people_cluster.organizing")
                : t("people_cluster.organize_btn", { count: organizePlan.assignments.length })}
            </button>
          </div>
        </div>
      </div>

      {/* Full-size Photo Lightbox */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setPreviewPhoto(null)}
        >
          <div
            className="bg-background border-border flex max-h-[90vh] max-w-[90vw] flex-col overflow-hidden rounded-xl border shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-border/60 flex items-center justify-between border-b px-4 py-2 text-xs">
              <span className="font-mono font-medium">{previewPhoto.fileName}</span>
              <button
                type="button"
                onClick={() => setPreviewPhoto(null)}
                className="text-muted-foreground hover:text-foreground rounded p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center justify-center p-3">
              <img
                src={buildFileThumbnailUrl(
                  previewPhoto.path,
                  previewPhoto.modified,
                  previewPhoto.size,
                  1600,
                  true,
                  false
                )}
                alt={previewPhoto.fileName}
                className="max-h-[78vh] max-w-[84vw] rounded object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
