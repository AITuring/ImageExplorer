import { useTranslation } from "react-i18next";
import {
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useClipboard } from "@/stores/clipboard";
import { EmptyAreaActions } from "@/types";
import { SYSTEM_PATHS, SF_SYMBOLS } from "@/constants/paths";
import { MenuItem } from "../MenuItem";
import { ArrowDownAZ, ArrowDownUp, FileText, Folder, RefreshCw, Terminal } from "lucide-react";

interface EmptyAreaMenuContentProps {
  actions: EmptyAreaActions;
}

export function EmptyAreaMenuContent({ actions }: EmptyAreaMenuContentProps) {
  const { t } = useTranslation();
  const clipboard = useClipboard();
  const sortOptions = [
    { field: "name" as const, label: t("context_menu.sort_name") },
    { field: "kind" as const, label: t("context_menu.sort_kind") },
    { field: "date" as const, label: t("context_menu.sort_modified") },
    { field: "created" as const, label: t("context_menu.sort_created") },
    { field: "size" as const, label: t("context_menu.sort_size") },
  ];

  const renderSortItems = (onSelect: (field: (typeof sortOptions)[number]["field"]) => void) =>
    sortOptions.map(({ field, label }) => (
      <MenuItem
        key={field}
        label={`${actions.sortField === field ? "✓ " : ""}${label}${
          actions.sortField === field ? (actions.sortDirection === "asc" ? " ↑" : " ↓") : ""
        }`}
        onClick={() => onSelect(field)}
      />
    ));

  return (
    <ContextMenuContent className="w-56">
      <MenuItem
        sysIcon={{ type: "ext", value: "txt" }}
        fallbackIcon={FileText}
        label={t("context_menu.new_file")}
        onClick={actions.onNewFile}
      />
      <MenuItem
        sysIcon={{ type: "folder" }}
        fallbackIcon={Folder}
        label={t("context_menu.new_folder")}
        onClick={actions.onNewFolder}
      />
      {clipboard.hasPending() && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.PASTE }}
          label={t("context_menu.paste")}
          shortcut="⌘V"
          onClick={actions.onPaste}
        />
      )}
      <MenuItem
        sysIcon={{ type: "path", value: SYSTEM_PATHS.TERMINAL_APP }}
        fallbackIcon={Terminal}
        label={t("context_menu.open_in_terminal")}
        onClick={actions.onOpenInTerminal}
      />
      <ContextMenuSeparator />
      <MenuItem
        sysIcon={{ type: "sfsymbol", value: SF_SYMBOLS.REFRESH }}
        fallbackIcon={RefreshCw}
        label={t("context_menu.refresh")}
        onClick={actions.onRefresh}
      />
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <ArrowDownAZ className="mr-2 h-4 w-4" />
          {t("context_menu.sort_by")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          {renderSortItems(actions.onSort)}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <MenuItem
        icon={<ArrowDownUp className="mr-2 h-4 w-4" />}
        label={t("context_menu.arrange")}
        onClick={actions.onArrange}
      />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <ArrowDownAZ className="mr-2 h-4 w-4" />
          {t("context_menu.arrange_by")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          {renderSortItems(actions.onArrangeBy)}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </ContextMenuContent>
  );
}
