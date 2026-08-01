import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileEntry } from "@/types";
import { RAW_IMAGE_EXTENSIONS } from "@/constants/fileTypes";

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

const QUICK_LOOK_CONTEXT_SIZE = 9;
const RAW_EXTENSIONS = new Set(RAW_IMAGE_EXTENSIONS);

function getQuickLookPaths(entry: FileEntry, entries: FileEntry[]) {
  if (RAW_EXTENSIONS.has((entry.extension || "").toLowerCase())) {
    // RAW 解码明显重于普通图片；当前文件单独启动，避免 Quick Look 同时
    // 预热相邻 RAW 文件。关闭后再次按空格仍可快速预览其他文件。
    return [entry.path];
  }

  const currentIndex = entries.findIndex((candidate) => candidate.path === entry.path);
  if (currentIndex < 0) {
    return [entry.path];
  }

  const start = Math.max(
    0,
    Math.min(
      currentIndex - Math.floor(QUICK_LOOK_CONTEXT_SIZE / 2),
      entries.length - QUICK_LOOK_CONTEXT_SIZE
    )
  );

  return entries
    .slice(start, start + QUICK_LOOK_CONTEXT_SIZE)
    .map((candidate) => candidate.path)
    .filter(Boolean);
}

function isRawImageEntry(entry: FileEntry) {
  return RAW_EXTENSIONS.has((entry.extension || "").toLowerCase());
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
      if (isMacOS && nativeQuickLookEnabled && (!entry || !isRawImageEntry(entry))) {
        if (!entry) {
          closeNativeQuickLook();
          setQuickLookEntryState(null);
          return;
        }

        void invoke("open_native_quick_look", {
          // qlmanage 会为传入的每个路径准备预览。大目录只传当前文件附近
          // 的少量条目，保留相邻文件切换能力，避免一次解码整个 RAW 文件夹。
          paths: getQuickLookPaths(entry, entries),
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

      if (entry && isMacOS && nativeQuickLookEnabled && isRawImageEntry(entry)) {
        // 从普通文件的系统 Quick Look 切换到 RAW 的应用内预览时，先关闭
        // 旧窗口，避免两个预览同时解码或遮挡当前预览。
        closeNativeQuickLook();
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
    // RAW 文件使用应用内预览，避免 qlmanage 启动和重复解码带来的延迟。
    useNativeQuickLook:
      isMacOS && nativeQuickLookEnabled && !(quickLookEntry && isRawImageEntry(quickLookEntry)),
  };
}
