import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  BookmarkPlus,
  Camera,
  CheckCircle2,
  Clock,
  FolderOpen,
  Link2,
  Loader2,
  MapPin,
  RefreshCw,
  Sliders,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useExifSyncDialog } from "@/stores/exifSyncDialog";
import { buildFileThumbnailUrl } from "@/lib/iconCache";
import { invalidateCache } from "@/lib/entriesCache";
import { invalidatePhotoMetadataCache } from "@/lib/photoMetadata";
import {
  buildExifPatchFromFields,
  EMPTY_EXIF_FIELDS,
  formatShutterDisplay,
  hasAnyPatchValue,
  parseGpsCoordinatePair,
  type ExifFields,
  type ExifFieldToggles,
  type ExifFolderInspection,
  type ExifPatchItem,
  type ExifPhotoAudit,
  type ExifPreset,
  type ExifSyncApplyResult,
} from "@/lib/exifSyncHelper";

type SyncMode = "sync_reference" | "auto_match" | "manual_global";
type AuditFilter = "all" | "missing_exif" | "missing_gps";

const PRESETS_STORAGE_KEY = "imageexplorer.exifSyncPresets.v1";

function loadSavedPresets(): ExifPreset[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ExifPreset =>
      Boolean(item && typeof item.id === "string" && typeof item.name === "string" && item.fields)
    );
  } catch {
    return [];
  }
}

function persistPresets(presets: ExifPreset[]) {
  try {
    window.localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Ignore storage quota errors
  }
}

function notifyDirectoryUpdated(directory: string, updatedPaths: string[]) {
  invalidatePhotoMetadataCache(updatedPaths);
  invalidateCache(directory);
  window.dispatchEvent(
    new CustomEvent("finder-tags-updated", {
      detail: { parentPath: directory, path: directory },
    })
  );
}

function getBaseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function formatCurrentLocalExifTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}:${pad(now.getMonth() + 1)}:${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function fieldsScore(fields: ExifFields): number {
  let score = 0;
  if (fields.capturedAt) score += 3;
  if (fields.make || fields.model) score += 2;
  if (fields.lens) score += 2;
  if (fields.iso) score += 1;
  if (fields.aperture) score += 1;
  if (fields.shutterSpeed) score += 1;
  if (fields.focalLength) score += 1;
  if (fields.latitude !== null && fields.longitude !== null) score += 2;
  return score;
}

function normalizeFieldsForEditor(fields: ExifFields): ExifFields {
  return {
    make: fields.make ?? null,
    model: fields.model ?? null,
    lens: fields.lens ?? null,
    iso: fields.iso ?? null,
    aperture: fields.aperture ?? null,
    shutterSpeed: fields.shutterSpeed ? formatShutterDisplay(fields.shutterSpeed) : null,
    focalLength: fields.focalLength ?? null,
    capturedAt: fields.capturedAt ?? null,
    latitude: fields.latitude ?? null,
    longitude: fields.longitude ?? null,
  };
}

export function ExifSyncDialog() {
  const { t } = useTranslation();
  const { isOpen, directory, selectedEntries, close } = useExifSyncDialog();

  const [mode, setMode] = useState<SyncMode>("sync_reference");
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [scopeSelectedOnly, setScopeSelectedOnly] = useState(false);

  const [loading, setLoading] = useState(false);
  const [inspection, setInspection] = useState<ExifFolderInspection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedPaths, setSelectedPaths] = useState<Record<string, boolean>>({});
  const [referencePath, setReferencePath] = useState<string>("");
  const [referenceExternalName, setReferenceExternalName] = useState<string | null>(null);
  const [loadingReference, setLoadingReference] = useState(false);

  const [fields, setFields] = useState<ExifFields>(EMPTY_EXIF_FIELDS);
  const [gpsPasteInput, setGpsPasteInput] = useState("");
  const [gpsPasteStatus, setGpsPasteStatus] = useState<"idle" | "ok" | "invalid">("idle");

  const [toggles, setToggles] = useState<ExifFieldToggles>({
    time: true,
    cameraLens: true,
    exposure: true,
    gps: true,
  });
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [incrementSeconds, setIncrementSeconds] = useState(false);
  const [syncFileMtime, setSyncFileMtime] = useState(true);

  const [presets, setPresets] = useState<ExifPreset[]>(() => loadSavedPresets());
  const [presetNameInput, setPresetNameInput] = useState("");
  const [showPresetSave, setShowPresetSave] = useState(false);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ExifSyncApplyResult | null>(null);

  const loadTokenRef = useRef(0);

  const selectedEntryPaths = useMemo(
    () => selectedEntries.filter((e) => !e.is_dir).map((e) => e.path),
    [selectedEntries]
  );

  const applyReferenceFields = useCallback(
    (sourceFields: ExifFields, path: string, externalName: string | null) => {
      const normalized = normalizeFieldsForEditor(sourceFields);
      setFields(normalized);
      setReferencePath(path);
      setReferenceExternalName(externalName);
      if (normalized.latitude !== null && normalized.longitude !== null) {
        setGpsPasteInput(`${normalized.latitude.toFixed(6)}, ${normalized.longitude.toFixed(6)}`);
        setGpsPasteStatus("ok");
      } else {
        setGpsPasteInput("");
        setGpsPasteStatus("idle");
      }
    },
    []
  );

  const runInspection = useCallback(
    async (opts?: { dir?: string; onlySelected?: boolean; preserveFields?: boolean }) => {
      const targetDir = opts?.dir ?? directory;
      if (!targetDir) return;
      const onlySel = opts?.onlySelected ?? scopeSelectedOnly;

      loadTokenRef.current += 1;
      const token = loadTokenRef.current;

      setLoading(true);
      setError(null);
      try {
        const res = await invoke<ExifFolderInspection>("inspect_folder_exif", {
          directory: targetDir,
          selectedPaths: onlySel ? selectedEntryPaths : [],
        });
        if (loadTokenRef.current !== token) return;
        setInspection(res);

        // Pre-select writable photos that are missing any EXIF or GPS (or all selected writable photos)
        const nextChecked: Record<string, boolean> = {};
        const preselectedSet = new Set(selectedEntryPaths);
        for (const photo of res.photos) {
          if (!photo.writable) {
            nextChecked[photo.path] = false;
            continue;
          }
          const hasMissing =
            photo.missingTime ||
            photo.missingCameraLens ||
            photo.missingExposure ||
            photo.missingGps;
          if (preselectedSet.size > 0) {
            nextChecked[photo.path] = preselectedSet.has(photo.path);
          } else {
            nextChecked[photo.path] = hasMissing;
          }
        }
        setSelectedPaths(nextChecked);

        if (!opts?.preserveFields) {
          // Pick the best EXIF-bearing photo in the folder as initial reference
          const candidates = [...res.photos]
            .filter((p) => fieldsScore(p.metadata) > 0)
            .sort((a, b) => fieldsScore(b.metadata) - fieldsScore(a.metadata));
          if (candidates.length > 0) {
            applyReferenceFields(candidates[0].metadata, candidates[0].path, null);
            setMode("sync_reference");
          } else {
            setFields(EMPTY_EXIF_FIELDS);
            setReferencePath("");
            setReferenceExternalName(null);
            setGpsPasteInput("");
            setGpsPasteStatus("idle");
            setMode("manual_global");
          }
        }
      } catch (err) {
        if (loadTokenRef.current !== token) return;
        setError(typeof err === "string" ? err : String(err));
      } finally {
        if (loadTokenRef.current === token) {
          setLoading(false);
        }
      }
    },
    [applyReferenceFields, directory, scopeSelectedOnly, selectedEntryPaths]
  );

  useEffect(() => {
    if (!isOpen || !directory) return;
    const timer = window.setTimeout(() => {
      const initialScopeSelected = selectedEntryPaths.length > 1;
      setScopeSelectedOnly(initialScopeSelected);
      setApplyResult(null);
      setFilter("all");
      setOverwriteExisting(false);
      setIncrementSeconds(false);
      void runInspection({
        dir: directory,
        onlySelected: initialScopeSelected,
        preserveFields: false,
      });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, directory]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !applying) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applying, close, isOpen]);

  const photoByPath = useMemo(() => {
    const map = new Map<string, ExifPhotoAudit>();
    for (const p of inspection?.photos ?? []) {
      map.set(p.path, p);
    }
    return map;
  }, [inspection]);

  const referenceCandidates = useMemo(() => {
    if (!inspection) return [];
    return [...inspection.photos]
      .filter((p) => fieldsScore(p.metadata) > 0)
      .sort((a, b) => fieldsScore(b.metadata) - fieldsScore(a.metadata));
  }, [inspection]);

  const filteredPhotos = useMemo(() => {
    if (!inspection) return [];
    return inspection.photos.filter((p) => {
      if (filter === "missing_exif") {
        return p.missingTime || p.missingCameraLens || p.missingExposure;
      }
      if (filter === "missing_gps") {
        return p.missingGps;
      }
      return true;
    });
  }, [filter, inspection]);

  const autoMatchedCount = useMemo(() => {
    if (!inspection) return 0;
    return inspection.photos.filter((p) => p.writable && Boolean(p.suggestedSourcePath)).length;
  }, [inspection]);

  const checkedWritablePhotos = useMemo(() => {
    if (!inspection) return [];
    return inspection.photos.filter((p) => p.writable && selectedPaths[p.path]);
  }, [inspection, selectedPaths]);

  const handleSelectReferenceFromFolder = useCallback(
    (path: string) => {
      const found = photoByPath.get(path);
      if (!found) return;
      applyReferenceFields(found.metadata, found.path, null);
      setMode("sync_reference");
    },
    [applyReferenceFields, photoByPath]
  );

  const handleBrowseExternalReference = useCallback(async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: t("exifSync.pickReferenceTitle", "选择参考照片（支持 JPG / HEIC / RAW）"),
        filters: [
          {
            name: "Photos",
            extensions: [
              "jpg",
              "jpeg",
              "heic",
              "heif",
              "png",
              "tif",
              "tiff",
              "arw",
              "cr2",
              "cr3",
              "nef",
              "raf",
              "orf",
              "rw2",
              "dng",
            ],
          },
        ],
      });
      if (!picked || typeof picked !== "string") return;
      setLoadingReference(true);
      setError(null);
      const refFields = await invoke<ExifFields>("read_reference_exif", { path: picked });
      applyReferenceFields(refFields, picked, getBaseName(picked));
      setMode("sync_reference");
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setLoadingReference(false);
    }
  }, [applyReferenceFields, t]);

  const handleGpsPasteChange = useCallback((value: string) => {
    setGpsPasteInput(value);
    if (!value.trim()) {
      setGpsPasteStatus("idle");
      return;
    }
    const parsed = parseGpsCoordinatePair(value);
    if (parsed) {
      setFields((prev) => ({
        ...prev,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
      }));
      setGpsPasteStatus("ok");
    } else {
      setGpsPasteStatus("invalid");
    }
  }, []);

  const handleSavePreset = useCallback(() => {
    const trimmed = presetNameInput.trim();
    if (!trimmed) return;
    const next: ExifPreset[] = [
      {
        id: `${Date.now()}`,
        name: trimmed,
        fields: { ...fields },
      },
      ...presets.filter((p) => p.name !== trimmed),
    ].slice(0, 12);
    setPresets(next);
    persistPresets(next);
    setPresetNameInput("");
    setShowPresetSave(false);
  }, [fields, presetNameInput, presets]);

  const handleDeletePreset = useCallback(
    (id: string) => {
      const next = presets.filter((p) => p.id !== id);
      setPresets(next);
      persistPresets(next);
    },
    [presets]
  );

  const handleApplyPreset = useCallback((preset: ExifPreset) => {
    const normalized = normalizeFieldsForEditor(preset.fields);
    setFields(normalized);
    if (normalized.latitude !== null && normalized.longitude !== null) {
      setGpsPasteInput(`${normalized.latitude.toFixed(6)}, ${normalized.longitude.toFixed(6)}`);
      setGpsPasteStatus("ok");
    } else {
      setGpsPasteInput("");
      setGpsPasteStatus("idle");
    }
  }, []);

  const handleSelectAllWritable = useCallback(() => {
    if (!inspection) return;
    const next: Record<string, boolean> = {};
    for (const p of inspection.photos) {
      next[p.path] = p.writable;
    }
    setSelectedPaths(next);
  }, [inspection]);

  const handleSelectMissingOnly = useCallback(() => {
    if (!inspection) return;
    const next: Record<string, boolean> = {};
    for (const p of inspection.photos) {
      if (!p.writable) {
        next[p.path] = false;
        continue;
      }
      const missing =
        filter === "missing_gps"
          ? p.missingGps
          : p.missingTime || p.missingCameraLens || p.missingExposure || p.missingGps;
      next[p.path] = missing;
    }
    setSelectedPaths(next);
  }, [filter, inspection]);

  const handleClearSelection = useCallback(() => {
    setSelectedPaths({});
  }, []);

  const patchesToApply = useMemo<ExifPatchItem[]>(() => {
    if (checkedWritablePhotos.length === 0) return [];
    const items: ExifPatchItem[] = [];

    if (mode === "auto_match") {
      for (const photo of checkedWritablePhotos) {
        if (!photo.suggestedSourcePath) continue;
        const src = photoByPath.get(photo.suggestedSourcePath);
        if (!src) continue;
        const patch = buildExifPatchFromFields(photo.path, src.metadata, toggles, 0);
        if (hasAnyPatchValue(patch)) {
          items.push(patch);
        }
      }
      return items;
    }

    checkedWritablePhotos.forEach((photo, index) => {
      // Skip writing a photo onto itself when it is the active reference
      if (mode === "sync_reference" && photo.path === referencePath && !overwriteExisting) {
        return;
      }
      const offset = incrementSeconds ? index : 0;
      const patch = buildExifPatchFromFields(photo.path, fields, toggles, offset);
      if (hasAnyPatchValue(patch)) {
        items.push(patch);
      }
    });
    return items;
  }, [
    checkedWritablePhotos,
    fields,
    incrementSeconds,
    mode,
    overwriteExisting,
    photoByPath,
    referencePath,
    toggles,
  ]);

  const handleApplySync = useCallback(async () => {
    if (patchesToApply.length === 0 || applying) return;
    setApplying(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await invoke<ExifSyncApplyResult>("apply_exif_sync", {
        request: {
          items: patchesToApply,
          overwriteExisting,
          syncFileMtime: syncFileMtime && toggles.time,
        },
      });
      setApplyResult(res);
      if (res.updatedPaths.length > 0) {
        notifyDirectoryUpdated(directory, res.updatedPaths);
      }
      await runInspection({ preserveFields: true });
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setApplying(false);
    }
  }, [
    applying,
    directory,
    overwriteExisting,
    patchesToApply,
    runInspection,
    syncFileMtime,
    toggles.time,
  ]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !applying) {
          close();
        }
      }}
    >
      <div className="bg-background border-border text-foreground flex h-[min(820px,92vh)] w-[min(1200px,96vw)] flex-col overflow-hidden rounded-xl border shadow-2xl">
        {/* Header */}
        <div className="border-border flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="bg-primary/12 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Camera className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold">
                  {t("exifSync.title", "一键补充 / 同步 EXIF 与 GPS")}
                </h2>
                <span className="bg-muted text-muted-foreground max-w-[320px] truncate rounded px-2 py-0.5 font-mono text-[11px]">
                  {getBaseName(directory)}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t(
                  "exifSync.subtitle",
                  "修复 PS 导出或修图后丢失的拍摄时间、机身/镜头参数与 GPS 定位（ImageIO 无损写入，不重压画质）"
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {inspection && (
              <div className="hidden items-center gap-1.5 text-xs md:flex">
                <span className="bg-muted rounded-full px-2.5 py-0.5 font-medium">
                  {t("exifSync.totalBadge", "共 {{count}} 张", { count: inspection.totalPhotos })}
                </span>
                {inspection.missingExifCount > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                    {t("exifSync.missingExifBadge", "缺 EXIF {{count}}", {
                      count: inspection.missingExifCount,
                    })}
                  </span>
                )}
                {inspection.missingGpsCount > 0 && (
                  <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 font-medium text-sky-600 dark:text-sky-400">
                    {t("exifSync.missingGpsBadge", "缺 GPS {{count}}", {
                      count: inspection.missingGpsCount,
                    })}
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => void runInspection({ preserveFields: true })}
              disabled={loading || applying}
              className="hover:bg-accent text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors disabled:opacity-50"
              title={t("exifSync.rescan", "重新扫描 EXIF")}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              <span>{t("exifSync.rescan", "重新扫描")}</span>
            </button>

            <button
              type="button"
              onClick={close}
              disabled={applying}
              className="hover:bg-accent text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors disabled:opacity-50"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Main 2-column Workbench */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Left Panel: Mode + Fields + Write Options */}
          <div className="border-border flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-b p-4 md:w-[410px] md:border-r md:border-b-0">
            {/* Mode Tabs */}
            <div className="bg-muted/70 grid grid-cols-3 gap-1 rounded-lg p-1 text-xs">
              <button
                type="button"
                onClick={() => setMode("sync_reference")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-all ${
                  mode === "sync_reference"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Link2 className="h-3.5 w-3.5" />
                <span>{t("exifSync.modeReference", "同步某张照片")}</span>
              </button>
              <button
                type="button"
                onClick={() => setMode("auto_match")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-all ${
                  mode === "auto_match"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>{t("exifSync.modeAutoMatch", "智能同名匹配")}</span>
              </button>
              <button
                type="button"
                onClick={() => setMode("manual_global")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-all ${
                  mode === "manual_global"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Sliders className="h-3.5 w-3.5" />
                <span>{t("exifSync.modeManual", "全局统一设置")}</span>
              </button>
            </div>

            {/* Mode-specific Header Box */}
            {mode === "sync_reference" && (
              <div className="bg-muted/35 border-border space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {t("exifSync.referenceSource", "参考来源照片")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleBrowseExternalReference()}
                    disabled={loadingReference}
                    className="text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors"
                  >
                    {loadingReference ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <FolderOpen className="h-3 w-3" />
                    )}
                    <span>{t("exifSync.browseOtherPhoto", "从磁盘选择原图...")}</span>
                  </button>
                </div>

                {referenceExternalName ? (
                  <div className="bg-background border-border flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                    <span className="truncate font-mono">{referenceExternalName}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setReferenceExternalName(null);
                        if (referenceCandidates[0]) {
                          handleSelectReferenceFromFolder(referenceCandidates[0].path);
                        }
                      }}
                      className="text-muted-foreground hover:text-foreground shrink-0 text-[11px]"
                    >
                      {t("exifSync.switchFolderRef", "切回本目录")}
                    </button>
                  </div>
                ) : (
                  <select
                    value={referencePath}
                    onChange={(e) => handleSelectReferenceFromFolder(e.target.value)}
                    className="bg-background border-border w-full rounded-md border px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {referenceCandidates.length === 0 ? (
                      <option value="">
                        {t(
                          "exifSync.noRefInFolder",
                          "当前目录暂无含 EXIF 的参考照片，可从磁盘选择"
                        )}
                      </option>
                    ) : (
                      referenceCandidates.map((cand) => (
                        <option key={cand.path} value={cand.path}>
                          {cand.fileName}
                          {cand.metadata.model ? ` · ${cand.metadata.model}` : ""}
                          {cand.metadata.capturedAt ? ` · ${cand.metadata.capturedAt}` : ""}
                        </option>
                      ))
                    )}
                  </select>
                )}
                <p className="text-muted-foreground text-[11px] leading-relaxed">
                  {t(
                    "exifSync.referenceHint",
                    "已自动读取参考照参数到下方，你可以直接同步或顺手补填 GPS / 镜头后再批量写入。"
                  )}
                </p>
              </div>
            )}

            {mode === "auto_match" && (
              <div className="space-y-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>
                    {t("exifSync.autoMatchSummary", "已自动匹配 {{count}} 组同名原图", {
                      count: autoMatchedCount,
                    })}
                  </span>
                </div>
                <p className="text-muted-foreground text-[11px] leading-relaxed">
                  {t(
                    "exifSync.autoMatchDesc",
                    "自动为每张修图导出文件（如 DSC01684_1.jpg）匹配同目录下同名原片或 RAW（如 DSC01684.jpg / .ARW），精准回填各自原始拍摄时间、曝光与镜头。"
                  )}
                </p>
              </div>
            )}

            {mode === "manual_global" && (
              <div className="bg-muted/35 border-border space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {t("exifSync.presetsTitle", "常用器材 / 地点预设")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPresetSave((v) => !v)}
                    className="text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors"
                  >
                    <BookmarkPlus className="h-3 w-3" />
                    <span>{t("exifSync.saveCurrentPreset", "存为预设")}</span>
                  </button>
                </div>

                {showPresetSave && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={presetNameInput}
                      onChange={(e) => setPresetNameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSavePreset();
                      }}
                      placeholder={t("exifSync.presetPlaceholder", "如：A7R5 + 50GM · 南京朝天宫")}
                      className="bg-background border-border min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={handleSavePreset}
                      disabled={!presetNameInput.trim()}
                      className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40"
                    >
                      {t("common.save", "保存")}
                    </button>
                  </div>
                )}

                {presets.length === 0 ? (
                  <p className="text-muted-foreground text-[11px]">
                    {t(
                      "exifSync.noPresets",
                      "填好常用机身、镜头或拍摄地 GPS 后点击「存为预设」，下次一键复用。"
                    )}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((preset) => (
                      <div
                        key={preset.id}
                        className="bg-background border-border inline-flex items-center gap-1 rounded-full border py-0.5 pr-1.5 pl-2.5 text-[11px]"
                      >
                        <button
                          type="button"
                          onClick={() => handleApplyPreset(preset)}
                          className="hover:text-primary max-w-[180px] truncate font-medium"
                        >
                          {preset.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePreset(preset.id)}
                          className="text-muted-foreground hover:text-destructive p-0.5"
                          title={t("common.delete", "删除")}
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Field Group Toggles */}
            <div className="space-y-1.5">
              <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                {t("exifSync.fieldsToSync", "需要补充 / 同步的字段组")}
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                {(
                  [
                    ["time", t("exifSync.groupTime", "拍摄时间")],
                    ["cameraLens", t("exifSync.groupCameraLens", "相机与镜头")],
                    ["exposure", t("exifSync.groupExposure", "曝光参数")],
                    ["gps", t("exifSync.groupGps", "GPS 定位")],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className={`border-border flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
                      toggles[key] ? "bg-primary/8 border-primary/40" : "bg-muted/20 opacity-65"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={toggles[key]}
                      onChange={(e) => setToggles((prev) => ({ ...prev, [key]: e.target.checked }))}
                      className="accent-primary h-3.5 w-3.5"
                    />
                    <span className="font-medium">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Editable Parameter Fields (visible in reference & manual modes) */}
            {mode !== "auto_match" && (
              <div className="space-y-3 text-xs">
                {/* DateTime */}
                <div
                  className={`space-y-1.5 ${toggles.time ? "" : "pointer-events-none opacity-45"}`}
                >
                  <div className="flex items-center justify-between">
                    <label className="text-muted-foreground flex items-center gap-1 font-medium">
                      <Clock className="h-3 w-3" />
                      <span>{t("exifSync.capturedAt", "拍摄时间 (EXIF)")}</span>
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setFields((prev) => ({
                          ...prev,
                          capturedAt: formatCurrentLocalExifTime(),
                        }))
                      }
                      className="text-primary text-[11px] hover:underline"
                    >
                      {t("exifSync.useNow", "填入当前时间")}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={fields.capturedAt ?? ""}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, capturedAt: e.target.value || null }))
                    }
                    placeholder="2026:11:16 21:17:00"
                    className="bg-background border-border w-full rounded-md border px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={incrementSeconds}
                      onChange={(e) => setIncrementSeconds(e.target.checked)}
                      className="accent-primary h-3 w-3"
                    />
                    <span>
                      {t("exifSync.incrementSeconds", "批量写入时每张递增 +1 秒（保持排序顺序）")}
                    </span>
                  </label>
                </div>

                {/* Camera & Lens */}
                <div
                  className={`space-y-1.5 ${toggles.cameraLens ? "" : "pointer-events-none opacity-45"}`}
                >
                  <div className="text-muted-foreground flex items-center gap-1 font-medium">
                    <Camera className="h-3 w-3" />
                    <span>{t("exifSync.cameraAndLens", "相机机身与镜头")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={fields.make ?? ""}
                      onChange={(e) =>
                        setFields((prev) => ({ ...prev, make: e.target.value || null }))
                      }
                      placeholder={t("exifSync.makePlaceholder", "品牌如 SONY")}
                      className="bg-background border-border rounded-md border px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      type="text"
                      value={fields.model ?? ""}
                      onChange={(e) =>
                        setFields((prev) => ({ ...prev, model: e.target.value || null }))
                      }
                      placeholder={t("exifSync.modelPlaceholder", "型号如 ILCE-7RM5")}
                      className="bg-background border-border rounded-md border px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <input
                    type="text"
                    value={fields.lens ?? ""}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, lens: e.target.value || null }))
                    }
                    placeholder={t("exifSync.lensPlaceholder", "镜头如 FE 50mm F1.2 GM")}
                    className="bg-background border-border w-full rounded-md border px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                {/* Exposure */}
                <div
                  className={`space-y-1.5 ${toggles.exposure ? "" : "pointer-events-none opacity-45"}`}
                >
                  <div className="text-muted-foreground font-medium">
                    {t("exifSync.exposureParams", "曝光参数")}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px]">
                        ISO
                      </span>
                      <input
                        type="text"
                        value={fields.iso ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, iso: e.target.value || null }))
                        }
                        placeholder="400"
                        className="bg-background border-border w-full rounded-md border py-1.5 pr-2 pl-9 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px]">
                        f/
                      </span>
                      <input
                        type="text"
                        value={fields.aperture ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, aperture: e.target.value || null }))
                        }
                        placeholder="1.4"
                        className="bg-background border-border w-full rounded-md border py-1.5 pr-2 pl-7 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px]">
                        {t("exifSync.shutterShort", "快门")}
                      </span>
                      <input
                        type="text"
                        value={fields.shutterSpeed ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, shutterSpeed: e.target.value || null }))
                        }
                        placeholder="1/250"
                        className="bg-background border-border w-full rounded-md border py-1.5 pr-2 pl-10 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px]">
                        mm
                      </span>
                      <input
                        type="text"
                        value={fields.focalLength ?? ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, focalLength: e.target.value || null }))
                        }
                        placeholder="50"
                        className="bg-background border-border w-full rounded-md border py-1.5 pr-2 pl-9 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>

                {/* GPS */}
                <div
                  className={`space-y-1.5 ${toggles.gps ? "" : "pointer-events-none opacity-45"}`}
                >
                  <div className="flex items-center justify-between">
                    <label className="text-muted-foreground flex items-center gap-1 font-medium">
                      <MapPin className="h-3 w-3" />
                      <span>{t("exifSync.gpsCoordinates", "GPS 经纬度")}</span>
                    </label>
                    {(fields.latitude !== null || fields.longitude !== null) && (
                      <button
                        type="button"
                        onClick={() => {
                          setFields((prev) => ({ ...prev, latitude: null, longitude: null }));
                          setGpsPasteInput("");
                          setGpsPasteStatus("idle");
                        }}
                        className="text-muted-foreground hover:text-destructive text-[11px]"
                      >
                        {t("exifSync.clearGps", "清空")}
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={gpsPasteInput}
                    onChange={(e) => handleGpsPasteChange(e.target.value)}
                    placeholder={t(
                      "exifSync.gpsPastePlaceholder",
                      "快速粘贴坐标：32.0415, 118.7892"
                    )}
                    className={`bg-background w-full rounded-md border px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-1 ${
                      gpsPasteStatus === "invalid"
                        ? "border-destructive focus:ring-destructive"
                        : "border-border focus:ring-blue-500"
                    }`}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px]">
                        {t("exifSync.latShort", "纬度")}
                      </span>
                      <input
                        type="number"
                        step="0.000001"
                        value={fields.latitude ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setFields((prev) => ({
                            ...prev,
                            latitude: v === "" ? null : Number(v),
                          }));
                        }}
                        placeholder="32.041500"
                        className="bg-background border-border w-full rounded-md border py-1.5 pr-2 pl-10 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="relative">
                      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px]">
                        {t("exifSync.lonShort", "经度")}
                      </span>
                      <input
                        type="number"
                        step="0.000001"
                        value={fields.longitude ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setFields((prev) => ({
                            ...prev,
                            longitude: v === "" ? null : Number(v),
                          }));
                        }}
                        placeholder="118.789200"
                        className="bg-background border-border w-full rounded-md border py-1.5 pr-2 pl-10 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Write Policy */}
            <div className="border-border space-y-2 border-t pt-3 text-xs">
              <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                {t("exifSync.writePolicy", "写入策略")}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setOverwriteExisting(false)}
                  className={`rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    !overwriteExisting
                      ? "border-primary bg-primary/10 text-foreground font-medium"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div>{t("exifSync.fillMissingOnly", "仅补全缺失字段")}</div>
                  <div className="text-muted-foreground text-[10px] font-normal">
                    {t("exifSync.fillMissingHint", "保留照片原有信息（推荐）")}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setOverwriteExisting(true)}
                  className={`rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    overwriteExisting
                      ? "text-foreground border-amber-500 bg-amber-500/10 font-medium"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div>{t("exifSync.overwriteExisting", "覆盖已有字段")}</div>
                  <div className="text-muted-foreground text-[10px] font-normal">
                    {t("exifSync.overwriteHint", "强制统一为设定值")}
                  </div>
                </button>
              </div>
              <label className="text-muted-foreground flex cursor-pointer items-center gap-2 pt-0.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={syncFileMtime}
                  onChange={(e) => setSyncFileMtime(e.target.checked)}
                  className="accent-primary h-3.5 w-3.5"
                />
                <span>
                  {t("exifSync.syncFileMtime", "同时将文件修改时间 (mtime) 同步为拍摄时间")}
                </span>
              </label>
            </div>
          </div>

          {/* Right Panel: Photo Audit List */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* List Toolbar */}
            <div className="border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-xs">
              <div className="flex items-center gap-1">
                {(
                  [
                    ["all", t("exifSync.filterAll", "全部"), inspection?.totalPhotos ?? 0],
                    [
                      "missing_exif",
                      t("exifSync.filterMissingExif", "缺失 EXIF"),
                      inspection?.missingExifCount ?? 0,
                    ],
                    [
                      "missing_gps",
                      t("exifSync.filterMissingGps", "缺失 GPS"),
                      inspection?.missingGpsCount ?? 0,
                    ],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                      filter === key
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-accent text-muted-foreground"
                    }`}
                  >
                    {label} ({count})
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {selectedEntryPaths.length > 0 && (
                  <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={scopeSelectedOnly}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setScopeSelectedOnly(next);
                        void runInspection({ onlySelected: next, preserveFields: true });
                      }}
                      className="accent-primary h-3 w-3"
                    />
                    <span>
                      {t("exifSync.selectedScopeOnly", "仅限已选 ({{count}})", {
                        count: selectedEntryPaths.length,
                      })}
                    </span>
                  </label>
                )}
                <button
                  type="button"
                  onClick={handleSelectMissingOnly}
                  className="hover:bg-accent text-muted-foreground hover:text-foreground rounded px-2 py-1 text-[11px]"
                >
                  {t("exifSync.selectMissing", "选缺失项")}
                </button>
                <button
                  type="button"
                  onClick={handleSelectAllWritable}
                  className="hover:bg-accent text-muted-foreground hover:text-foreground rounded px-2 py-1 text-[11px]"
                >
                  {t("exifSync.selectAllWritable", "全选可写")}
                </button>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="hover:bg-accent text-muted-foreground hover:text-foreground rounded px-2 py-1 text-[11px]"
                >
                  {t("exifSync.clearSelection", "取消全选")}
                </button>
              </div>
            </div>

            {/* List Body */}
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {loading && !inspection ? (
                <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-xs">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>{t("exifSync.scanning", "正在审计目录中的照片 EXIF 与 GPS 信息...")}</span>
                </div>
              ) : filteredPhotos.length === 0 ? (
                <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-xs">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                  <span>{t("exifSync.emptyFiltered", "当前筛选条件下没有照片")}</span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredPhotos.map((photo) => {
                    const isChecked = Boolean(selectedPaths[photo.path]);
                    const isCurrentRef = mode === "sync_reference" && photo.path === referencePath;
                    const hasAnyMissing =
                      photo.missingTime ||
                      photo.missingCameraLens ||
                      photo.missingExposure ||
                      photo.missingGps;
                    const hasSomeExif = fieldsScore(photo.metadata) > 0;
                    const suggestedName = photo.suggestedSourcePath
                      ? getBaseName(photo.suggestedSourcePath)
                      : null;

                    const summaryParts: string[] = [];
                    if (photo.metadata.capturedAt) summaryParts.push(photo.metadata.capturedAt);
                    const cam = [photo.metadata.make, photo.metadata.model]
                      .filter(Boolean)
                      .join(" ");
                    if (cam) summaryParts.push(cam);
                    if (photo.metadata.lens) summaryParts.push(photo.metadata.lens);
                    const exp = [
                      photo.metadata.focalLength ? `${photo.metadata.focalLength}mm` : null,
                      photo.metadata.aperture ? `f/${photo.metadata.aperture}` : null,
                      photo.metadata.shutterSpeed
                        ? formatShutterDisplay(photo.metadata.shutterSpeed)
                        : null,
                      photo.metadata.iso ? `ISO ${photo.metadata.iso}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    if (exp) summaryParts.push(exp);
                    if (photo.metadata.latitude !== null && photo.metadata.longitude !== null) {
                      summaryParts.push(
                        `GPS ${photo.metadata.latitude.toFixed(4)}, ${photo.metadata.longitude.toFixed(4)}`
                      );
                    }

                    return (
                      <div
                        key={photo.path}
                        className={`border-border flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                          isCurrentRef
                            ? "border-primary/60 bg-primary/6"
                            : isChecked
                              ? "bg-muted/35"
                              : "bg-background hover:bg-muted/20"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={!photo.writable}
                          onChange={(e) =>
                            setSelectedPaths((prev) => ({
                              ...prev,
                              [photo.path]: e.target.checked,
                            }))
                          }
                          title={
                            photo.writable
                              ? undefined
                              : t("exifSync.rawReadOnlyTip", "RAW 文件仅作参考来源，不直接写入修改")
                          }
                          className="accent-primary h-4 w-4 shrink-0 disabled:opacity-35"
                        />

                        <img
                          src={buildFileThumbnailUrl(
                            photo.path,
                            160,
                            photo.modified ?? 0,
                            photo.size
                          )}
                          alt={photo.fileName}
                          loading="lazy"
                          className="bg-muted h-11 w-11 shrink-0 rounded-md object-cover"
                        />

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="max-w-[260px] truncate text-xs font-medium">
                              {photo.fileName}
                            </span>

                            {!photo.writable && (
                              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                                {t("exifSync.rawBadge", "RAW 仅参考")}
                              </span>
                            )}

                            {isCurrentRef && (
                              <span className="bg-primary/15 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">
                                {t("exifSync.activeRefBadge", "当前参考照")}
                              </span>
                            )}

                            {!hasAnyMissing ? (
                              <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="h-2.5 w-2.5" />
                                {t("exifSync.completeBadge", "EXIF & GPS 完整")}
                              </span>
                            ) : (
                              <>
                                {photo.missingTime && (
                                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                    {t("exifSync.missTime", "缺时间")}
                                  </span>
                                )}
                                {photo.missingCameraLens && (
                                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                    {t("exifSync.missCamera", "缺相机/镜头")}
                                  </span>
                                )}
                                {photo.missingExposure && (
                                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                    {t("exifSync.missExposure", "缺曝光")}
                                  </span>
                                )}
                                {photo.missingGps && (
                                  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                                    {t("exifSync.missGps", "缺 GPS")}
                                  </span>
                                )}
                              </>
                            )}

                            {mode === "auto_match" && photo.writable && (
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  suggestedName
                                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                    : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {suggestedName
                                  ? `← ${suggestedName}`
                                  : t("exifSync.noAutoMatch", "无同名参考源")}
                              </span>
                            )}
                          </div>

                          <div className="text-muted-foreground truncate font-mono text-[11px]">
                            {summaryParts.length > 0
                              ? summaryParts.join(" · ")
                              : t("exifSync.noExifDetected", "未检测到 EXIF 与 GPS 元数据")}
                          </div>
                        </div>

                        {hasSomeExif && !isCurrentRef && (
                          <button
                            type="button"
                            onClick={() => handleSelectReferenceFromFolder(photo.path)}
                            className="border-border hover:bg-accent text-muted-foreground hover:text-foreground shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
                          >
                            {t("exifSync.setAsReference", "设为参考")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-border bg-muted/25 flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <div className="min-w-0 flex-1 text-xs">
            {error ? (
              <div className="text-destructive flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="truncate">{error}</span>
              </div>
            ) : applyResult ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  {t(
                    "exifSync.applyDone",
                    "已完成：更新 {{updated}} 张，跳过无需变更 {{unchanged}} 张",
                    {
                      updated: applyResult.updated,
                      unchanged: applyResult.unchanged,
                    }
                  )}
                </span>
                {applyResult.failed.length > 0 && (
                  <span className="text-destructive">
                    {t("exifSync.applyFailed", "失败 {{count}} 张：{{detail}}", {
                      count: applyResult.failed.length,
                      detail: applyResult.failed.slice(0, 2).join("；"),
                    })}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">
                {t(
                  "exifSync.footerNote",
                  "支持 JPG / HEIC / PNG / TIFF 无损写入；RAW 格式自动保护，可作为参考源提取完整参数。"
                )}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={close}
              disabled={applying}
              className="border-border hover:bg-accent rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            >
              {t("common.close", "关闭")}
            </button>
            <button
              type="button"
              onClick={() => void handleApplySync()}
              disabled={applying || patchesToApply.length === 0}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-45"
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5" />
              )}
              <span>
                {applying
                  ? t("exifSync.applying", "正在写入 EXIF...")
                  : t("exifSync.applyButton", "一键补充写入 ({{count}} 张)", {
                      count: patchesToApply.length,
                    })}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
