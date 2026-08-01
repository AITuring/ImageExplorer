import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileEntry } from "@/types";

interface UseQuickLookOptions {
  selectedPath: string | null;
  editingPath: string | null;
  entries: FileEntry[];
}

interface UseQuickLookResult {
  quickLookEntry: FileEntry | null;
  setQuickLookEntry: (entry: FileEntry | null) => void;
  toggleQuickLook: () => void;
  useNativeQuickLook: boolean;
}

export function useQuickLook({
  selectedPath,
  editingPath,
  entries,
}: UseQuickLookOptions): UseQuickLookResult {
  const [quickLookEntry, setQuickLookEntryState] = useState<FileEntry | null>(null);
  const [nativeQuickLookEnabled, setNativeQuickLookEnabled] = useState(true);
  const isMacOS = useMemo(() => {
    if (typeof navigator === "undefined") {
      return false;
    }

    return /mac os|macintosh|macintosh/i.test(navigator.userAgent);
  }, []);

  const closeNativeQuickLook = useCallback(() => {
    void invoke("close_native_quick_look").catch(() => {});
  }, []);

  const setQuickLookEntry = useCallback(
    (entry: FileEntry | null) => {
      if (isMacOS && nativeQuickLookEnabled) {
        if (!entry) {
          closeNativeQuickLook();
          setQuickLookEntryState(null);
          return;
        }

        void invoke("open_native_quick_look", {
          paths: entries.map((item) => item.path),
          currentPath: entry.path,
        })
          .then(() => {
            setQuickLookEntryState(entry);
          })
          .catch((error) => {
            console.error("Failed to open native Quick Look", error);
            setNativeQuickLookEnabled(false);
            setQuickLookEntryState(entry);
          });
        return;
      }

      setQuickLookEntryState(entry);
    },
    [closeNativeQuickLook, entries, isMacOS, nativeQuickLookEnabled]
  );

  // 切换快速预览
  const toggleQuickLook = useCallback(() => {
    if (quickLookEntry) {
      setQuickLookEntry(null);
    } else if (selectedPath) {
      const entry = entries.find((e) => e.path === selectedPath);
      if (entry) {
        setQuickLookEntry(entry);
      }
    }
  }, [entries, quickLookEntry, selectedPath, setQuickLookEntry]);

  useEffect(() => {
    return () => {
      if (isMacOS && nativeQuickLookEnabled) {
        closeNativeQuickLook();
      }
    };
  }, [closeNativeQuickLook, isMacOS, nativeQuickLookEnabled]);

  // Quick Look 快捷键 (Space)
  useEffect(() => {
    const handleQuickLookShortcut = (e: KeyboardEvent) => {
      // 忽略按键重复事件
      if (e.repeat) return;

      if (e.code === "Space" && !editingPath) {
        e.preventDefault();
        toggleQuickLook();
      }
    };
    window.addEventListener("keydown", handleQuickLookShortcut);
    return () => window.removeEventListener("keydown", handleQuickLookShortcut);
  }, [editingPath, toggleQuickLook]);

  return {
    quickLookEntry,
    setQuickLookEntry,
    toggleQuickLook,
    useNativeQuickLook: isMacOS && nativeQuickLookEnabled,
  };
}
