import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { FileEntry } from "@/types";

interface UseFileRenameOptions {
  entries: FileEntry[];
  editingPath: string | null;
  editValue: string;
  setEditingPath: (path: string | null) => void;
  setEditValue: (value: string) => void;
  setSelectedPath: (path: string) => void;
  onRefresh: () => void;
}

interface UseFileRenameResult {
  handleStartRename: (entry: FileEntry) => void;
  handleSubmitRename: () => Promise<void>;
  handleCancelRename: () => void;
}

export function useFileRename({
  entries,
  editingPath,
  editValue,
  setEditingPath,
  setEditValue,
  setSelectedPath,
  onRefresh,
}: UseFileRenameOptions): UseFileRenameResult {
  const { t } = useTranslation();

  // 开始重命名
  const handleStartRename = useCallback(
    (entry: FileEntry) => {
      if (entry.readonly) return;
      setSelectedPath(entry.path);
      setEditingPath(entry.path);
      setEditValue(entry.name);
    },
    [setSelectedPath, setEditingPath, setEditValue]
  );

  // 取消重命名
  const handleCancelRename = useCallback(() => {
    setEditingPath(null);
    setEditValue("");
  }, [setEditingPath, setEditValue]);

  // 提交重命名
  const handleSubmitRename = useCallback(async () => {
    if (!editingPath || !editValue.trim()) {
      handleCancelRename();
      return;
    }

    const entry = entries.find((e) => e.path === editingPath);
    if (entry && entry.name === editValue) {
      handleCancelRename();
      return;
    }

    try {
      await invoke("rename", { path: editingPath, newName: editValue });
      onRefresh();
    } catch (e) {
      console.error("Failed to rename:", e);
      alert(t("file_list.error_rename", { error: String(e) }));
    } finally {
      handleCancelRename();
    }
  }, [editingPath, editValue, entries, handleCancelRename, onRefresh, t]);

  // 窗口失焦时取消重命名
  useEffect(() => {
    if (!editingPath) return;

    const handleWindowBlur = () => {
      handleCancelRename();
    };

    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [editingPath, handleCancelRename]);

  return {
    handleStartRename,
    handleSubmitRename,
    handleCancelRename,
  };
}
