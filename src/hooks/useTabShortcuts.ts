/**
 * useTabShortcuts Hook
 * 单一职责：处理 Tab 相关键盘快捷键
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabs } from "./useTabs";
import {
  getCurrentKeyboardCommandScope,
  registerKeyboardCommands,
} from "@/lib/keyboardShortcuts";
import { useSetting } from "@/hooks/useSetting";

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen("menu-new-window-request", () => {
      if (getCurrentKeyboardCommandScope() !== "file-view") return;
      void import("@/lib/windowManager")
        .then(({ windowManager }) => windowManager.createWindow({ path: activeTab?.path }))
        .catch((error) => console.error("Failed to create a new window:", error));
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((error) => console.error("Failed to register the new-window command:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeTab?.path]);

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
