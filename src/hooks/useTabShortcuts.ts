/**
 * useTabShortcuts Hook
 * 单一职责：处理 Tab 相关键盘快捷键
 */
import { useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabs } from "./useTabs";
import {
  getCurrentKeyboardCommandScope,
  registerKeyboardCommands,
} from "@/lib/keyboardShortcuts";
import { useSetting } from "@/hooks/useSetting";
import {
  registerAppCommands,
  runRegisteredCommand,
  type AppCommand,
} from "@/lib/commands";
import { editCommands } from "@/lib/editCommands";

function isModifierPressed(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function matchesModifiedKey(event: KeyboardEvent, key: string, shift = false): boolean {
  return (
    isModifierPressed(event) &&
    event.key.toLowerCase() === key &&
    event.shiftKey === shift &&
    !event.altKey
  );
}

export function useTabShortcuts() {
  const { tabs, activeTabId, addTab, closeTab, setActiveTab, activeTab } = useTabs();
  const [legacyTabNumberShortcuts] = useSetting<boolean>("legacy_cmd_number_tabs", false);
  const newWindowCommand = useMemo<AppCommand<void>>(
    () => ({
      id: "window.new",
      enabled: () => getCurrentKeyboardCommandScope() === "file-view",
      run: async () => {
        const { windowManager } = await import("@/lib/windowManager");
        await windowManager.createWindow({ path: activeTab?.path });
      },
    }),
    [activeTab?.path]
  );

  useEffect(() => {
    return registerAppCommands([newWindowCommand, ...editCommands]);
  }, [newWindowCommand]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<string>("app-command", ({ payload }) => {
      if (
        (payload === "file.new-file" || payload === "file.new-folder") &&
        getCurrentKeyboardCommandScope() !== "file-view"
      ) {
        return;
      }
      runRegisteredCommand(payload);
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((error) => console.error("Failed to register the app command listener:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return registerKeyboardCommands([
      {
        id: "tabs.new",
        scope: "file-view",
        matches: (event) => matchesModifiedKey(event, "t"),
        run: () => addTab(activeTab?.path || "/"),
      },
      {
        id: "tabs.close",
        scope: "file-view",
        matches: (event) => matchesModifiedKey(event, "w"),
        enabled: () => tabs.length > 1,
        run: () => closeTab(activeTabId),
      },
      {
        id: "tabs.previous",
        scope: "file-view",
        matches: (event) =>
          isModifierPressed(event) &&
          event.code === "BracketLeft" &&
          event.shiftKey &&
          !event.altKey,
        enabled: () => tabs.findIndex((tab) => tab.id === activeTabId) > 0,
        run: () => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          if (currentIndex > 0) setActiveTab(tabs[currentIndex - 1].id);
        },
      },
      {
        id: "tabs.next",
        scope: "file-view",
        matches: (event) =>
          isModifierPressed(event) &&
          event.code === "BracketRight" &&
          event.shiftKey &&
          !event.altKey,
        enabled: () => tabs.findIndex((tab) => tab.id === activeTabId) < tabs.length - 1,
        run: () => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          if (currentIndex < tabs.length - 1) setActiveTab(tabs[currentIndex + 1].id);
        },
      },
      {
        id: "tabs.switch-by-number",
        scope: "file-view",
        matches: (event) =>
          isModifierPressed(event) &&
          !event.shiftKey &&
          !event.altKey &&
          /^[1-9]$/.test(event.key),
        enabled: () => legacyTabNumberShortcuts,
        run: (event) => {
          const targetIndex = Number.parseInt(event.key, 10) - 1;
          const targetTab = tabs[targetIndex];
          if (targetTab) setActiveTab(targetTab.id);
        },
      },
    ]);
  }, [
    tabs,
    activeTabId,
    activeTab,
    addTab,
    closeTab,
    setActiveTab,
    legacyTabNumberShortcuts,
  ]);
}
