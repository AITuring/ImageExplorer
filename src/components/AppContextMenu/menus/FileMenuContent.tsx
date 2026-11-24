import { useTranslation } from "react-i18next";
import { openWithService } from "@/lib/openWith";
import {
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useClipboard } from "@/stores/clipboard";
import { isCommandEnabled, runCommand } from "@/lib/commands";
import { FINDER_TAG_PRESETS, hasFinderTag } from "@/lib/finderTags";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import { FileEntry, FileActions } from "@/types";
import { SYSTEM_PATHS, SF_SYMBOLS } from "@/constants/paths";
import { MenuItem } from "../MenuItem";
import { LoadableOpenWithMenu } from "../LoadableOpenWithMenu";
import {
  ArrowUpRight,
  Archive,
  Clipboard,
  Columns2,
  Copy,
  FolderPlus,
  ImageDown,
  Info,
  Landmark,
  Star,
  Link,
  Pencil,
  PackageOpen,
  RotateCcw,
  RotateCw,
  Scissors,
  Share,
  Terminal,
  Trash2,
  Users,
} from "lucide-react";

const ROTATABLE_IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "tif",
  "tiff",
  "webp",
  "bmp",
]);

interface FileMenuContentProps {
  entry: FileEntry;
  selectedEntries?: FileEntry[];
  actions: FileActions;
}

export function FileMenuContent({ entry, selectedEntries, actions }: FileMenuContentProps) {
  const { t } = useTranslation();
  const clipboard = useClipboard();

  // 如果右键的文件在多选中，操作多选集合；否则只操作右键的文件
  const targets =
    selectedEntries &&
    selectedEntries.length > 1 &&
    selectedEntries.some((e) => e.path === entry.path)
      ? selectedEntries
      : [entry];

  return (
    <ContextMenuContent className="w-56">
      <ContextMenuLabel className="max-w-[12rem] truncate">{entry.name}</ContextMenuLabel>
      <ContextMenuSeparator />

      <MenuItem
        icon={<img src="/logo-menu.png" className="mr-2 h-4 w-4" alt="ImageExplorer" />}
        label={t("context_menu.open")}
        disabled={actions.commands?.open ? !isCommandEnabled(actions.commands.open, entry) : false}
        onClick={() =>
          actions.commands?.open ? runCommand(actions.commands.open, entry) : actions.onOpen(entry)
        }
      />

      {entry.is_dir && actions.onOpenInNewTab && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: "plus.square.on.square" }}
          fallbackIcon={FolderPlus}
          label={t("context_menu.open_in_new_tab")}
          onClick={() => actions.onOpenInNewTab?.(entry)}
        />
      )}

      {entry.is_package && entry.is_dir && actions.onShowPackageContents && (
        <MenuItem
          fallbackIcon={PackageOpen}
          label={t("context_menu.show_package_contents")}
          onClick={() => actions.onShowPackageContents?.(entry)}
        />
      )}

      {(entry.is_symlink || entry.is_alias) && actions.onShowOriginal && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: "arrow.turn.up.right" }}
          fallbackIcon={ArrowUpRight}
          label={t("context_menu.show_original")}
          onClick={() => actions.onShowOriginal?.(entry)}
        />
      )}

      {actions.onGoToLocation && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: "arrow.turn.up.right" }}
          fallbackIcon={ArrowUpRight}
          label={t("context_menu.go_to_location", "Go to File Location")}
          onClick={() => actions.onGoToLocation?.(entry)}
        />
      )}

      {/* 打开方式子菜单 */}
      {!entry.is_dir && <LoadableOpenWithMenu entry={entry} />}

      {entry.is_dir && (
        <MenuItem
          sysIcon={{ type: "path", value: SYSTEM_PATHS.TERMINAL_APP }}
          fallbackIcon={Terminal}
          label={t("context_menu.open_in_terminal")}
          onClick={() => openWithService.openInDefaultTerminal(entry.path)}
        />
      )}

      <ContextMenuSeparator />

      <MenuItem
        sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.COPY }}
        fallbackIcon={Copy}
        label={t("context_menu.copy")}
        shortcut={actions.commands?.copy?.shortcut ?? "⌘C"}
        disabled={
          actions.commands?.copy ? !isCommandEnabled(actions.commands.copy, targets) : false
        }
        onClick={() =>
          actions.commands?.copy
            ? runCommand(actions.commands.copy, targets)
            : actions.onCopy(targets)
        }
      />

      <MenuItem
        sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.CUT }}
        fallbackIcon={Scissors}
        label={t("context_menu.cut")}
        shortcut={actions.commands?.cut?.shortcut ?? "⌘X"}
        disabled={actions.commands?.cut ? !isCommandEnabled(actions.commands.cut, targets) : false}
        onClick={() =>
          actions.commands?.cut ? runCommand(actions.commands.cut, targets) : actions.onCut(targets)
        }
      />

      {clipboard.hasPending() && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.PASTE }}
          fallbackIcon={Clipboard}
          label={t("context_menu.paste")}
          shortcut={actions.commands?.paste?.shortcut ?? "⌘V"}
          disabled={actions.commands?.paste ? !isCommandEnabled(actions.commands.paste) : false}
          onClick={() =>
            actions.commands?.paste ? runCommand(actions.commands.paste) : actions.onPaste()
          }
        />
      )}

      {actions.onDuplicate && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.COPY }}
          fallbackIcon={Copy}
          label={t("context_menu.duplicate")}
          shortcut={actions.commands?.duplicate?.shortcut ?? "⌘D"}
          disabled={
            actions.commands?.duplicate
              ? !isCommandEnabled(actions.commands.duplicate, targets)
              : false
          }
          onClick={() =>
            actions.commands?.duplicate
              ? runCommand(actions.commands.duplicate, targets)
              : actions.onDuplicate?.(targets)
          }
        />
      )}

      <ContextMenuSeparator />

      {!entry.readonly && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.RENAME }}
          fallbackIcon={Pencil}
          label={t("context_menu.rename")}
          shortcut={actions.commands?.rename?.shortcut ?? "Enter"}
          disabled={
            actions.commands?.rename ? !isCommandEnabled(actions.commands.rename, entry) : false
          }
          onClick={() =>
            actions.commands?.rename
              ? runCommand(actions.commands.rename, entry)
              : actions.onRename?.(entry)
          }
        />
      )}

      {targets.length >= 2 &&
        actions.onCompare &&
        (() => {
          const photos = targets.filter(isAnalyzablePhoto);
          if (photos.length < 2) return null;
          return (
            <MenuItem
              fallbackIcon={Columns2}
              label={t("context_menu.compare_photos")}
              onClick={() => actions.onCompare?.(photos.slice(0, 4))}
            />
          );
        })()}

      {targets.length >= 1 &&
        actions.onBatchExport &&
        (() => {
          const photos = targets.filter(isAnalyzablePhoto);
          if (photos.length === 0) return null;
          return (
            <MenuItem
              fallbackIcon={ImageDown}
              label={t("context_menu.batch_export")}
              onClick={() => actions.onBatchExport?.(photos)}
            />
          );
        })()}

      {actions.onExhibitLabelMode &&
        (() => {
          if (targets.length === 1 && targets[0].is_dir && !targets[0].is_package) {
            return (
              <MenuItem
                fallbackIcon={Landmark}
                label={t("context_menu.exhibit_label_mode")}
                onClick={() => actions.onExhibitLabelMode?.(targets)}
              />
            );
          }
          const photos = targets.filter(isAnalyzablePhoto);
          if (photos.length === 0) return null;
          return (
            <MenuItem
              fallbackIcon={Landmark}
              label={
                photos.length > 1
                  ? t("context_menu.exhibit_label_mode_selected", { count: photos.length })
                  : t("context_menu.exhibit_label_mode")
              }
              onClick={() => actions.onExhibitLabelMode?.(photos)}
            />
          );
        })()}

      {actions.onPeopleClusterMode &&
        (() => {
          if (targets.length === 1 && targets[0].is_dir && !targets[0].is_package) {
            return (
              <MenuItem
                fallbackIcon={Users}
                label={t("context_menu.people_cluster_mode")}
                onClick={() => actions.onPeopleClusterMode?.(targets)}
              />
            );
          }
          const photos = targets.filter(isAnalyzablePhoto);
          if (photos.length === 0) return null;
          return (
            <MenuItem
              fallbackIcon={Users}
              label={
                photos.length > 1
                  ? t("context_menu.people_cluster_mode_selected", { count: photos.length })
                  : t("context_menu.people_cluster_mode")
              }
              onClick={() => actions.onPeopleClusterMode?.(photos)}
            />
          );
        })()}

      {targets.length > 1 && actions.onBatchRename && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.RENAME }}
          fallbackIcon={Pencil}
          label={t("context_menu.batch_rename")}
          onClick={() => actions.onBatchRename?.(targets)}
        />
      )}

      <MenuItem
        sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.PASTE }}
        fallbackIcon={Link}
        label={t("context_menu.copy_path")}
        onClick={() => actions.onCopyPath(entry)}
      />

      {actions.onCompress && (
        <MenuItem
          fallbackIcon={Archive}
          label={t("context_menu.compress_zip")}
          onClick={() => actions.onCompress?.(targets)}
        />
      )}

      {actions.onExtract && entry.extension?.toLowerCase() === "zip" && (
        <MenuItem
          fallbackIcon={PackageOpen}
          label={t("context_menu.extract_zip")}
          onClick={() => actions.onExtract?.(entry)}
        />
      )}

      {actions.onRotateImage &&
        (() => {
          const rotatable = targets.filter(
            (item) =>
              !item.is_dir &&
              !item.readonly &&
              ROTATABLE_IMAGE_EXTS.has((item.extension ?? "").toLowerCase())
          );
          if (rotatable.length === 0) return null;
          return (
            <>
              <MenuItem
                fallbackIcon={RotateCcw}
                label={t("context_menu.rotate_left")}
                onClick={() => actions.onRotateImage?.(rotatable, false)}
              />
              <MenuItem
                fallbackIcon={RotateCw}
                label={t("context_menu.rotate_right")}
                onClick={() => actions.onRotateImage?.(rotatable, true)}
              />
            </>
          );
        })()}

      {actions.onShare && (
        <MenuItem
          fallbackIcon={Share}
          label={t("context_menu.share")}
          onClick={() => actions.onShare?.(targets)}
        />
      )}

      {actions.onGetInfo && (
        <MenuItem
          fallbackIcon={Info}
          label={
            targets.length > 1
              ? t("context_menu.get_info_multi", { count: targets.length })
              : t("context_menu.get_info")
          }
          shortcut="⌘I"
          onClick={() => actions.onGetInfo?.(targets.length > 1 ? targets : entry)}
        />
      )}

      {actions.onToggleFavorite && entry.is_dir && (
        <MenuItem
          fallbackIcon={Star}
          label={t(
            actions.isFavorite?.(entry)
              ? "context_menu.remove_from_favorites"
              : "context_menu.add_to_favorites"
          )}
          onClick={() => actions.onToggleFavorite?.(entry)}
        />
      )}

      {actions.onToggleTag && (
        <>
          <ContextMenuSeparator />
          <div className="px-2 py-1.5">
            <div className="text-muted-foreground mb-1.5 text-[11px] font-medium">
              {t("context_menu.tags")}
            </div>
            <div className="flex items-center gap-1.5">
              {FINDER_TAG_PRESETS.map((preset) => {
                const isActive = targets.every((item) => hasFinderTag(item.tags, preset.id));
                const label = t(preset.labelKey);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={isActive}
                    onClick={(event) => {
                      event.stopPropagation();
                      actions.onToggleTag?.(targets, preset.id);
                    }}
                    className={`flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                      isActive
                        ? "ring-foreground ring-offset-popover ring-2 ring-offset-1"
                        : "ring-1 ring-black/15 dark:ring-white/20"
                    }`}
                    style={{ backgroundColor: preset.color }}
                  >
                    {isActive && <span className="h-1.5 w-1.5 rounded-full bg-white shadow-sm" />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!entry.readonly && (
        <>
          <ContextMenuSeparator />
          <MenuItem
            sysIcon={{ type: "path", value: SYSTEM_PATHS.TRASH_ICON }}
            fallbackIcon={Trash2}
            label={t("context_menu.move_to_trash")}
            disabled={
              actions.commands?.delete ? !isCommandEnabled(actions.commands.delete, targets) : false
            }
            onClick={() =>
              actions.commands?.delete
                ? runCommand(actions.commands.delete, targets)
                : actions.onDelete(targets)
            }
            destructive
          />
        </>
      )}
    </ContextMenuContent>
  );
}
