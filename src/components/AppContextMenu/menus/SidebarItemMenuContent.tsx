import { useTranslation } from "react-i18next";
import { openWithService } from "@/lib/openWith";
import {
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { SidebarItemActions } from "@/types";
import { SYSTEM_PATHS } from "@/constants/paths";
import { SMART_FOLDER_PREFIX } from "@/constants/config";
import { MenuItem } from "../MenuItem";
import { AppWindow, FolderPlus, LogOut, Star, Terminal, X } from "lucide-react";

interface SidebarItemMenuContentProps {
  actions: SidebarItemActions;
}

export function SidebarItemMenuContent({ actions }: SidebarItemMenuContentProps) {
  const { t } = useTranslation();
  const isSmartFolder = actions.path.startsWith(SMART_FOLDER_PREFIX);

  return (
    <ContextMenuContent className="w-52">
      <ContextMenuLabel className="max-w-[12rem] truncate">{actions.name}</ContextMenuLabel>
      <ContextMenuSeparator />
      <MenuItem
        icon={<img src="/logo-menu.png" className="mr-2 h-4 w-4" alt="ImageExplorer" />}
        label={t("context_menu.open")}
        onClick={actions.onOpen}
      />
      {actions.onOpenInNewTab && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: "plus.square.on.square" }}
          fallbackIcon={FolderPlus}
          label={t("context_menu.open_in_new_tab")}
          onClick={actions.onOpenInNewTab}
        />
      )}
      {actions.onOpenInNewWindow && (
        <MenuItem
          sysIcon={{ type: "sfsymbol", value: "macwindow.badge.plus" }}
          fallbackIcon={AppWindow}
          label={t("context_menu.open_in_new_window")}
          onClick={actions.onOpenInNewWindow}
        />
      )}
      {!isSmartFolder && (
        <MenuItem
          sysIcon={{ type: "path", value: SYSTEM_PATHS.TERMINAL_APP }}
          fallbackIcon={Terminal}
          label={t("context_menu.open_in_terminal")}
          onClick={() => openWithService.openInDefaultTerminal(actions.path)}
        />
      )}
      {actions.onToggleFavorite && (
        <MenuItem
          fallbackIcon={Star}
          label={t(
            actions.isFavorite
              ? "context_menu.remove_from_favorites"
              : "context_menu.add_to_favorites"
          )}
          onClick={actions.onToggleFavorite}
        />
      )}
      {actions.onRemoveRecent && (
        <MenuItem
          fallbackIcon={X}
          label={t("context_menu.remove_from_recent")}
          onClick={actions.onRemoveRecent}
        />
      )}
      {actions.onEject && (
        <>
          <ContextMenuSeparator />
          <MenuItem
            fallbackIcon={LogOut}
            label={t("context_menu.eject")}
            onClick={actions.onEject}
          />
        </>
      )}
      {actions.onRemoveFromSidebar && (
        <MenuItem
          fallbackIcon={X}
          label={t("context_menu.remove_from_sidebar")}
          onClick={actions.onRemoveFromSidebar}
        />
      )}
    </ContextMenuContent>
  );
}
