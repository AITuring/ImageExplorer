import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { File, Folder, Files, Link, Package, Info, Loader2, Lock, Unlock } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFileInfoDialog } from "@/stores/fileInfoDialog";
import { FINDER_TAG_PRESETS, hasFinderTag } from "@/lib/finderTags";
import { invalidateCache } from "@/lib/entriesCache";
import type { FileEntry } from "@/types";
import { formatFileSize } from "@/utils/format";

interface DirectorySizeSummary {
  path: string;
  total_bytes: number;
  file_count: number;
  dir_count: number;
}

function formatTimestamp(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function formatMode(mode: number | null | undefined) {
  if (mode === null || mode === undefined) return null;
  return `0${(mode & 0o7777).toString(8).padStart(4, "0")}`;
}

function formatOwner(details: FileEntry): string | null {
  if (details.owner_name || details.group_name) {
    const owner = details.owner_name ?? details.uid?.toString() ?? "—";
    const group = details.group_name ?? details.gid?.toString() ?? "—";
    return `${owner} (${group})`;
  }
  if (details.uid === null || details.uid === undefined) return null;
  return `${details.uid}:${details.gid ?? "—"}`;
}

export function FileInfoDialog() {
  const { t } = useTranslation();
  const entries = useFileInfoDialog((state) => state.entries);
  const entry = useFileInfoDialog((state) => state.entry);
  const close = useFileInfoDialog((state) => state.close);
  const isMulti = entries.length > 1;

  const [loadedEntry, setLoadedEntry] = useState<FileEntry | null>(null);
  const [multiEntries, setMultiEntries] = useState<FileEntry[] | null>(null);
  const [dirSize, setDirSize] = useState<DirectorySizeSummary | null>(null);
  const [multiFolderBytes, setMultiFolderBytes] = useState<{
    key: string;
    bytes: number;
    done: boolean;
  } | null>(null);
  const [calculatingSize, setCalculatingSize] = useState(false);
  const [updatingLock, setUpdatingLock] = useState(false);
  const sizeRequestIdRef = useRef(0);

  const multiKey = useMemo(() => entries.map((e) => e.path).join("\u0000"), [entries]);

  useEffect(() => {
    if (!entry || isMulti) return;

    let cancelled = false;
    invoke<FileEntry>("get_file_entry", { path: entry.path })
      .then((freshEntry) => {
        if (!cancelled) setLoadedEntry(freshEntry);
      })
      .catch(() => {
        // Search results can refer to an item that disappeared. The original
        // lightweight entry remains useful and keeps the dialog readable.
      });
    return () => {
      cancelled = true;
    };
  }, [entry, isMulti]);

  const details = !isMulti && entry && loadedEntry?.path === entry.path ? loadedEntry : entry;
  const activeMultiEntries = useMemo(() => {
    if (!isMulti) return [];
    if (
      multiEntries &&
      multiEntries.length === entries.length &&
      multiEntries.every((item, idx) => item.path === entries[idx].path)
    ) {
      return multiEntries;
    }
    return entries;
  }, [entries, isMulti, multiEntries]);

  const dirTargetPath = !isMulti && details?.is_dir ? details.path : null;

  // Single-folder size calculation
  useEffect(() => {
    if (!dirTargetPath) return;

    let cancelled = false;
    const requestId = Date.now() * 1000 + ((sizeRequestIdRef.current += 1) % 1000);

    const run = async () => {
      setCalculatingSize(true);
      try {
        const summary = await invoke<DirectorySizeSummary>("calculate_directory_size", {
          path: dirTargetPath,
          requestId,
        });
        if (!cancelled) {
          setDirSize(summary);
        }
      } catch {
        // Cancelled or unreadable directory
      } finally {
        if (!cancelled) {
          setCalculatingSize(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      void invoke("cancel_directory_size", { requestId: requestId + 1 }).catch(() => undefined);
    };
  }, [dirTargetPath]);

  // Multi-selection folder size aggregation
  useEffect(() => {
    if (!isMulti) return;
    const dirs = entries.filter((e) => e.is_dir);
    if (dirs.length === 0) return;

    let cancelled = false;
    const requestId = Date.now() * 1000 + ((sizeRequestIdRef.current += 1) % 1000);

    const run = async () => {
      let total = 0;
      for (const dir of dirs) {
        if (cancelled) return;
        try {
          const summary = await invoke<DirectorySizeSummary>("calculate_directory_size", {
            path: dir.path,
            requestId,
          });
          total += summary.total_bytes;
        } catch {
          // skip unreadable dir
        }
      }
      if (!cancelled) {
        setMultiFolderBytes({ key: multiKey, bytes: total, done: true });
      }
    };

    void run();
    return () => {
      cancelled = true;
      void invoke("cancel_directory_size", { requestId: requestId + 1 }).catch(() => undefined);
    };
  }, [entries, isMulti, multiKey]);

  const notifyParentsUpdated = useCallback((paths: string[]) => {
    const parents = new Set<string>();
    for (const p of paths) {
      parents.add(p.slice(0, p.lastIndexOf("/")) || "/");
    }
    for (const parent of parents) {
      invalidateCache(parent);
      window.dispatchEvent(
        new CustomEvent("finder-tags-updated", {
          detail: { parentPath: parent, path: paths[0] },
        })
      );
    }
  }, []);

  const handleToggleTag = useCallback(
    async (tagId: string) => {
      if (isMulti) {
        const paths = activeMultiEntries.map((item) => item.path);
        if (paths.length === 0) return;
        try {
          const updatedTags = await invoke<string[]>("toggle_file_tag", { paths, tag: tagId });
          const allHad = activeMultiEntries.every((item) => hasFinderTag(item.tags, tagId));
          setMultiEntries(
            activeMultiEntries.map((item) => {
              const current = item.tags ?? [];
              if (allHad) {
                return {
                  ...item,
                  tags: current.filter((tag) => tag.toLowerCase() !== tagId.toLowerCase()),
                };
              }
              return hasFinderTag(current, tagId)
                ? item
                : {
                    ...item,
                    tags: [
                      ...current,
                      updatedTags.find((t) => t.toLowerCase() === tagId.toLowerCase()) ?? tagId,
                    ],
                  };
            })
          );
          notifyParentsUpdated(paths);
        } catch (error) {
          console.error("Failed to batch toggle Finder tag:", error);
        }
        return;
      }

      if (!details) return;
      try {
        const updatedTags = await invoke<string[]>("toggle_file_tag", {
          paths: [details.path],
          tag: tagId,
        });
        setLoadedEntry({ ...details, tags: updatedTags });
        notifyParentsUpdated([details.path]);
      } catch (error) {
        console.error("Failed to toggle Finder tag:", error);
      }
    },
    [activeMultiEntries, details, isMulti, notifyParentsUpdated]
  );

  const handleToggleLocked = useCallback(async () => {
    if (updatingLock) return;
    if (isMulti) {
      if (activeMultiEntries.length === 0) return;
      const allLocked = activeMultiEntries.every((item) => Boolean(item.is_locked));
      const nextLocked = !allLocked;
      setUpdatingLock(true);
      try {
        await Promise.all(
          activeMultiEntries.map((item) =>
            invoke<boolean>("set_file_locked", { path: item.path, locked: nextLocked })
          )
        );
        setMultiEntries(activeMultiEntries.map((item) => ({ ...item, is_locked: nextLocked })));
        notifyParentsUpdated(activeMultiEntries.map((item) => item.path));
      } catch (error) {
        console.error("Failed to batch toggle file lock:", error);
        alert(t("file_info.lock_failed", { error: String(error) }));
      } finally {
        setUpdatingLock(false);
      }
      return;
    }

    if (!details) return;
    const nextLocked = !details.is_locked;
    setUpdatingLock(true);
    try {
      const confirmedLocked = await invoke<boolean>("set_file_locked", {
        path: details.path,
        locked: nextLocked,
      });
      setLoadedEntry({ ...details, is_locked: confirmedLocked });
      notifyParentsUpdated([details.path]);
    } catch (error) {
      console.error("Failed to toggle file lock:", error);
      alert(t("file_info.lock_failed", { error: String(error) }));
    } finally {
      setUpdatingLock(false);
    }
  }, [activeMultiEntries, details, isMulti, notifyParentsUpdated, t, updatingLock]);

  const matchingDirSize = details?.is_dir && dirSize?.path === details.path ? dirSize : null;

  const sizeValue = useMemo(() => {
    if (!details) return null;
    if (!details.is_dir) return formatFileSize(details.size);
    if (matchingDirSize) {
      return t("file_info.size_folder_detail", {
        size:
          matchingDirSize.total_bytes === 0 ? "0 B" : formatFileSize(matchingDirSize.total_bytes),
        files: matchingDirSize.file_count,
        dirs: matchingDirSize.dir_count,
      });
    }
    return calculatingSize ? t("file_info.size_calculating") : "—";
  }, [calculatingSize, details, matchingDirSize, t]);

  const rows = useMemo(() => {
    if (!details || isMulti) return [];
    const values: Array<[string, string | null]> = [
      [t("file_info.kind"), details.is_dir ? t("file_info.folder") : t("file_info.file")],
      [t("file_info.path"), details.path],
      [t("file_info.size"), sizeValue],
      [t("file_info.modified"), formatTimestamp(details.modified)],
      [t("file_info.created"), formatTimestamp(details.created)],
      [t("file_info.accessed"), formatTimestamp(details.accessed)],
      [t("file_info.readonly"), details.readonly ? t("common.yes") : t("common.no")],
      [t("file_info.mode"), formatMode(details.mode)],
      [t("file_info.owner"), formatOwner(details)],
      [t("file_info.file_attributes"), details.file_attributes?.toString() ?? null],
      [t("file_info.symlink_target"), details.symlink_target ?? null],
      [t("file_info.alias_target"), details.alias_target ?? null],
      [t("file_info.package_type"), details.package_type ?? null],
    ];
    return values.filter(([, value]) => value !== null);
  }, [details, isMulti, sizeValue, t]);

  const multiSummary = useMemo(() => {
    if (!isMulti) return null;
    let fileBytes = 0;
    let fileCount = 0;
    let dirCount = 0;
    const extCounts = new Map<string, number>();
    for (const item of activeMultiEntries) {
      if (item.is_dir) {
        dirCount += 1;
      } else {
        fileCount += 1;
        fileBytes += Math.max(0, item.size);
        const ext = (item.extension || "file").toUpperCase();
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      }
    }
    const hasDirs = dirCount > 0;
    const folderBytesReady = !hasDirs || multiFolderBytes?.key === multiKey;
    const totalBytes =
      fileBytes + (multiFolderBytes?.key === multiKey ? multiFolderBytes.bytes : 0);
    const topExts = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext} ×${count}`)
      .join(" · ");
    const allLocked = activeMultiEntries.every((item) => Boolean(item.is_locked));
    const someLocked = activeMultiEntries.some((item) => Boolean(item.is_locked));
    return {
      fileCount,
      dirCount,
      totalBytes,
      folderBytesReady,
      topExts,
      allLocked,
      someLocked,
    };
  }, [activeMultiEntries, isMulti, multiFolderBytes, multiKey]);

  return (
    <Dialog open={entries.length > 0} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {isMulti ? (
              <Files className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details?.is_symlink || details?.is_alias ? (
              <Link className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details?.is_package ? (
              <Package className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details?.is_dir ? (
              <Folder className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details ? (
              <File className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <Info className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">
              {isMulti
                ? t("file_info.multi_title", { count: entries.length })
                : (details?.name ?? t("file_info.title"))}
            </span>
            {!isMulti && details?.is_locked && (
              <Lock
                className="text-muted-foreground h-3.5 w-3.5 shrink-0"
                aria-label={t("file_info.locked")}
              />
            )}
          </DialogTitle>
          <DialogDescription>
            {isMulti ? t("file_info.multi_description") : t("file_info.description")}
          </DialogDescription>
        </DialogHeader>

        {isMulti && multiSummary ? (
          <dl className="max-h-[min(58vh,520px)] space-y-2 overflow-y-auto pr-1 text-sm">
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.size")}</dt>
              <dd className="flex items-center gap-1.5 font-mono text-xs">
                {!multiSummary.folderBytesReady && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                )}
                <span>
                  {formatFileSize(multiSummary.totalBytes)}
                  {!multiSummary.folderBytesReady ? ` (${t("file_info.size_calculating")})` : ""}
                </span>
              </dd>
            </div>
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.kind")}</dt>
              <dd className="text-xs">
                {t("file_info.multi_breakdown", {
                  files: multiSummary.fileCount,
                  dirs: multiSummary.dirCount,
                })}
                {multiSummary.topExts ? ` · ${multiSummary.topExts}` : ""}
              </dd>
            </div>

            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.tags")}</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {FINDER_TAG_PRESETS.map((preset) => {
                  const allActive = activeMultiEntries.every((item) =>
                    hasFinderTag(item.tags, preset.id)
                  );
                  const someActive =
                    !allActive &&
                    activeMultiEntries.some((item) => hasFinderTag(item.tags, preset.id));
                  const label = t(preset.labelKey);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => void handleToggleTag(preset.id)}
                      aria-pressed={allActive}
                      title={label}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        allActive
                          ? "border-foreground/30 bg-accent text-foreground font-medium"
                          : someActive
                            ? "border-primary/40 bg-primary/10 text-foreground"
                            : "border-border/60 text-muted-foreground hover:bg-accent/50"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full ring-1 ring-black/15"
                        style={{ backgroundColor: preset.color }}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </dd>
            </div>

            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.locked")}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={multiSummary.allLocked}
                  disabled={updatingLock}
                  onClick={() => void handleToggleLocked()}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    multiSummary.allLocked
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : multiSummary.someLocked
                        ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                        : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {updatingLock ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : multiSummary.allLocked ? (
                    <Lock className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Unlock className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span>
                    {multiSummary.allLocked
                      ? t("common.yes")
                      : multiSummary.someLocked
                        ? t("file_info.mixed")
                        : t("common.no")}
                  </span>
                </button>
                <span className="text-muted-foreground text-xs">{t("file_info.locked_hint")}</span>
              </dd>
            </div>

            <div className="pt-1">
              <dt className="text-muted-foreground mb-1 text-xs">
                {t("file_info.selected_items")}
              </dt>
              <dd className="bg-muted/30 max-h-36 space-y-0.5 overflow-y-auto rounded-md border p-2 font-mono text-[11px]">
                {activeMultiEntries.slice(0, 50).map((item) => (
                  <div key={item.path} className="flex items-center justify-between gap-2">
                    <span className="truncate">{item.name}</span>
                    <span className="text-muted-foreground shrink-0">
                      {item.is_dir ? "--" : formatFileSize(item.size)}
                    </span>
                  </div>
                ))}
                {activeMultiEntries.length > 50 && (
                  <div className="text-muted-foreground pt-1">
                    +{activeMultiEntries.length - 50}
                  </div>
                )}
              </dd>
            </div>
          </dl>
        ) : details ? (
          <dl className="max-h-[min(58vh,520px)] space-y-2 overflow-y-auto pr-1 text-sm">
            {details.is_package && (
              <div className="bg-muted/50 rounded-md px-3 py-2">
                <dt className="text-muted-foreground text-xs">{t("file_info.package")}</dt>
                <dd className="font-medium">
                  {t("file_info.package_value", { type: details.package_type ?? "" })}
                </dd>
              </div>
            )}
            {details.is_alias && (
              <div className="bg-muted/50 rounded-md px-3 py-2">
                <dt className="text-muted-foreground text-xs">{t("file_info.alias")}</dt>
                <dd className="font-medium">{t("file_info.alias_value")}</dd>
              </div>
            )}
            {details.is_symlink && (
              <div className="bg-muted/50 rounded-md px-3 py-2">
                <dt className="text-muted-foreground text-xs">{t("file_info.symlink")}</dt>
                <dd className="font-medium">{t("file_info.symlink_value")}</dd>
              </div>
            )}

            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.tags")}</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {FINDER_TAG_PRESETS.map((preset) => {
                  const active = hasFinderTag(details.tags, preset.id);
                  const label = t(preset.labelKey);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => void handleToggleTag(preset.id)}
                      aria-pressed={active}
                      title={label}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        active
                          ? "border-foreground/30 bg-accent text-foreground font-medium"
                          : "border-border/60 text-muted-foreground hover:bg-accent/50"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full ring-1 ring-black/15"
                        style={{ backgroundColor: preset.color }}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </dd>
            </div>

            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.locked")}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(details.is_locked)}
                  disabled={updatingLock}
                  onClick={() => void handleToggleLocked()}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    details.is_locked
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {updatingLock ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : details.is_locked ? (
                    <Lock className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Unlock className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span>{details.is_locked ? t("common.yes") : t("common.no")}</span>
                </button>
                <span className="text-muted-foreground text-xs">{t("file_info.locked_hint")}</span>
              </dd>
            </div>

            {rows.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b pb-2 last:border-b-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs break-words">
                  {label === t("file_info.size") &&
                    details.is_dir &&
                    calculatingSize &&
                    !matchingDirSize && (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                    )}
                  <span className="min-w-0 break-words">{value}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
