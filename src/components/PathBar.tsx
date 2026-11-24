import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, Folder, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SMART_FOLDER_PREFIX } from "@/constants/config";
import { getFinderTagColor, matchFinderTagPreset } from "@/lib/finderTags";
import { useStatusBar } from "@/stores/statusBar";
import { ICON_SIZE_MAX, ICON_SIZE_MIN, useViewMode } from "@/stores/viewMode";
import { formatFileSize } from "@/utils/format";
import { isTerminalOperationStatus } from "@/hooks/useOperationCenter";
import type { FileOperationSnapshot } from "@/types";

interface DiskSpace {
  path: string;
  available_bytes: number | null;
}

interface PathBarProps {
  path: string;
  onNavigate: (path: string) => void;
}

/** Keep ancestor navigation and Finder-style status metrics in the bottom bar. */
export function PathBar({ path, onNavigate }: PathBarProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLElement>(null);
  const segments = path.split("/").filter(Boolean);
  const statusPath = useStatusBar((s) => s.path);
  const totalCount = useStatusBar((s) => s.totalCount);
  const selectedCount = useStatusBar((s) => s.selectedCount);
  const selectedBytes = useStatusBar((s) => s.selectedBytes);
  const loading = useStatusBar((s) => s.loading);
  const viewMode = useViewMode((s) => s.viewMode);
  const iconSize = useViewMode((s) => s.iconSize);
  const setIconSize = useViewMode((s) => s.setIconSize);
  const [availableBytes, setAvailableBytes] = useState<number | null>(null);
  const isSmartFolder = path.startsWith(SMART_FOLDER_PREFIX);
  const tagSmartPrefix = `${SMART_FOLDER_PREFIX}tag:`;
  const smartTagName = path.startsWith(tagSmartPrefix) ? path.slice(tagSmartPrefix.length) : null;
  const smartTagPreset = smartTagName ? matchFinderTagPreset(smartTagName) : undefined;
  const smartTagLabel = smartTagName
    ? smartTagPreset
      ? t(smartTagPreset.labelKey)
      : smartTagName
    : null;

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [path]);

  useEffect(() => {
    if (!path || isSmartFolder) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const refreshDiskSpace = async () => {
      try {
        const result = await invoke<DiskSpace>("get_disk_space", { path });
        if (!cancelled) {
          setAvailableBytes(result.available_bytes);
        }
      } catch {
        if (!cancelled) setAvailableBytes(null);
      }
    };

    void refreshDiskSpace();

    void listen<FileOperationSnapshot>("file-operation-updated", (event) => {
      if (!cancelled && isTerminalOperationStatus(event.payload.status)) {
        void refreshDiskSpace();
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isSmartFolder, path]);

  const displayedAvailableBytes = !path || isSmartFolder ? null : availableBytes;
  const hasMatchingStatus = statusPath === path && !loading;

  const statusText = (() => {
    const parts: string[] = [];
    if (hasMatchingStatus) {
      if (selectedCount > 0) {
        const selectionBase = t("file_list.status_selected", {
          selected: selectedCount,
          total: totalCount,
        });
        parts.push(
          selectedBytes > 0 ? `${selectionBase} (${formatFileSize(selectedBytes)})` : selectionBase
        );
      } else {
        parts.push(t("file_list.items_count", { count: totalCount }));
      }
    }
    if (displayedAvailableBytes !== null) {
      parts.push(
        t("file_list.status_available", {
          size: formatFileSize(displayedAvailableBytes),
        })
      );
    }
    return parts.join(" · ");
  })();

  return (
    <div className="finder-pathbar">
      <nav
        ref={scrollRef}
        className="finder-pathbar-breadcrumbs flex min-w-0 flex-1 items-center gap-[3px] overflow-x-auto"
        aria-label={t("nav.path")}
      >
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onNavigate("/")}
          title="/"
          aria-label={t("nav.computer")}
        >
          <HardDrive size={13} aria-hidden="true" />
        </button>
        {smartTagName && smartTagLabel && (
          <span className="flex shrink-0 items-center gap-1.5 px-1">
            <ChevronRight size={11} className="opacity-40" aria-hidden="true" />
            <span
              className="h-2.5 w-2.5 rounded-full ring-1 ring-black/15 dark:ring-white/20"
              style={{ backgroundColor: getFinderTagColor(smartTagName) }}
              aria-hidden="true"
            />
            <span className="text-foreground font-medium">{smartTagLabel}</span>
          </span>
        )}
        {!isSmartFolder &&
          segments.map((name, index) => {
            const destination = "/" + segments.slice(0, index + 1).join("/");
            return (
              <span className="flex shrink-0 items-center gap-1" key={destination}>
                <ChevronRight size={11} className="opacity-40" aria-hidden="true" />
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onNavigate(destination)}
                  title={destination}
                  aria-current={index === segments.length - 1 ? "location" : undefined}
                >
                  <Folder size={13} aria-hidden="true" />
                  <span className="max-w-48 truncate">{name}</span>
                </button>
              </span>
            );
          })}
      </nav>
      <div className="flex shrink-0 items-center gap-3">
        {viewMode === "icon" && (
          <label className="flex items-center gap-1.5" title={t("common.icon_size")}>
            <input
              type="range"
              min={ICON_SIZE_MIN}
              max={ICON_SIZE_MAX}
              step={8}
              value={iconSize}
              onChange={(event) => setIconSize(Number(event.target.value))}
              onPointerUp={(event) => event.currentTarget.blur()}
              onMouseUp={(event) => event.currentTarget.blur()}
              aria-label={t("common.icon_size")}
              className="accent-primary h-1 w-20 cursor-pointer"
            />
          </label>
        )}
        {statusText && (
          <div
            role="status"
            aria-live="polite"
            className="finder-statusbar-meta shrink-0 pl-3 text-[11px] whitespace-nowrap tabular-nums opacity-85"
          >
            {statusText}
          </div>
        )}
      </div>
    </div>
  );
}
