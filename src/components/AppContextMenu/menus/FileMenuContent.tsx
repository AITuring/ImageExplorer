import { useTranslation } from "react-i18next";
import { openWithService } from "@/lib/openWith";
import {
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useClipboard } from "@/stores/clipboard";
import { FileEntry, FileActions } from "@/types";
import { SYSTEM_PATHS, SF_SYMBOLS } from "@/constants/paths";
import { MenuItem } from "../MenuItem";
import { LoadableOpenWithMenu } from "../LoadableOpenWithMenu";
import {
  ArrowUpRight,
  Archive,
  Clipboard,
  Copy,
  FolderPlus,
  Info,
  Star,
  Link,
  Pencil,
  PackageOpen,
  Scissors,
  Terminal,
  Trash2,
} from "lucide-react";

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
        icon={<img src="/logo.svg" className="mr-2 h-4 w-4" alt="HyperExplorer" />}
        label={t("context_menu.open")}
        onClick={() => actions.onOpen(entry)}
      />

      {entry.is_dir && actions.onOpenInNewTab && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: "plus.square.on.square" }}
          fallbackIcon={FolderPlus}
          label={t("context_menu.open_in_new_tab")}
          onClick={() => actions.onOpenInNewTab?.(entry)}
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
        shortcut="⌘C"
        onClick={() => actions.onCopy(targets)}
      />

      <MenuItem
        sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.CUT }}
        fallbackIcon={Scissors}
        label={t("context_menu.cut")}
        shortcut="⌘X"
        onClick={() => actions.onCut(targets)}
      />

      {clipboard.hasPending() && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.PASTE }}
          fallbackIcon={Clipboard}
          label={t("context_menu.paste")}
          shortcut="⌘V"
          onClick={actions.onPaste}
        />
      )}

      <ContextMenuSeparator />

      {!entry.readonly && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.RENAME }}
          fallbackIcon={Pencil}
          label={t("context_menu.rename")}
          shortcut="Enter"
          onClick={() => actions.onRename?.(entry)}
        />
      )}

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

      {actions.onGetInfo && (
        <MenuItem
          fallbackIcon={Info}
          label={t("context_menu.get_info")}
          shortcut="⌘I"
          onClick={() => actions.onGetInfo?.(entry)}
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

      {!entry.readonly && (
        <>
          <ContextMenuSeparator />
          <MenuItem
            sysIcon={{ type: "path", value: SYSTEM_PATHS.TRASH_ICON }}
            fallbackIcon={Trash2}
            label={t("context_menu.move_to_trash")}
            onClick={() => actions.onDelete(targets)}
            destructive
          />
        </>
      )}
    </ContextMenuContent>
  );
}
