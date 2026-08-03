import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { FileEntry, FileOperationSnapshot } from "@/types";
import { useClipboard } from "@/stores/clipboard";
import { openWithService } from "@/lib/openWith";
import { isTerminalOperationStatus } from "@/hooks/useOperationCenter";
import { invalidateCache } from "@/lib/entriesCache";
import {
  enqueueCompressOperation,
  enqueueExtractOperation,
  enqueueFileOperation,
} from "@/lib/fileOperations";

interface UseFileOperationsOptions {
  currentPath: string;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onStartRename: (path: string, name: string) => void;
}

export function useFileOperations({
  currentPath,
  onRefresh,
  onNavigate,
  onStartRename,
}: UseFileOperationsOptions) {
  const { t } = useTranslation();
  const clipboard = useClipboard();
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  // 刷新当前目录只在后台任务结束时触发，避免队列中的每个进度事件都
  // 重新加载目录数据。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<FileOperationSnapshot>("file-operation-updated", (event) => {
        if (!cancelled && isTerminalOperationStatus(event.payload.status)) {
          // 多窗口共享同一个文件系统操作，但每个 WebView 都有自己的目录缓存。
          // 完成事件到达时先清掉当前窗口缓存，再重新读取真实目录。
          invalidateCache(currentPath);
          void onRefreshRef.current();
        }
      });
    };

    setup().catch((error) => console.error("Failed to listen for file operations:", error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [currentPath]);

  const handleOpen = useCallback(
    (entry: FileEntry) => {
      // macOS application packages should launch on double-click; other
      // packages and directories remain browsable until "Show Package
      // Contents" is added to the context menu.
      const shouldOpenAsFile = entry.is_package && entry.package_type === "app";
      if (entry.is_dir && !shouldOpenAsFile) {
        onNavigate(entry.path);
      } else {
        invoke("open_file", { path: entry.path }).catch((e) => {
          console.error("Failed to open file:", e);
        });
      }
    },
    [onNavigate]
  );

  const handleCopy = useCallback(
    (entries: FileEntry[]) => {
      clipboard.copy(entries.map((e) => e.path));
    },
    [clipboard]
  );

  const handleCut = useCallback(
    (entries: FileEntry[]) => {
      clipboard.cut(entries.map((e) => e.path));
    },
    [clipboard]
  );

  const handlePaste = useCallback(async () => {
    if (!clipboard.hasPending()) return;

    const paths = [...clipboard.paths];
    const operation = clipboard.operation;

    try {
      if (operation === "copy") {
        await enqueueFileOperation({ kind: "copy", paths, destDir: currentPath });
      } else if (operation === "cut") {
        const operationId = await enqueueFileOperation({
          kind: "move",
          paths,
          destDir: currentPath,
        });
        // 剪切语义只应消费一次；实际结果会在进度中心中显示。
        if (operationId) clipboard.clear();
      }
    } catch (error) {
      console.error("Failed to enqueue paste operation:", error);
      alert(t("file_list.error_paste", { error: String(error) }));
    }
  }, [clipboard, currentPath, t]);

  const handleDelete = useCallback(
    async (entries: FileEntry[]) => {
      try {
        await invoke<string>("start_delete_operation", {
          paths: entries.map((entry) => entry.path),
        });
      } catch (error) {
        console.error("Failed to enqueue delete operation:", error);
        alert(t("file_list.error_delete", { error: String(error) }));
      }
    },
    [t]
  );

  const handleCompress = useCallback(
    async (entries: FileEntry[]) => {
      try {
        await enqueueCompressOperation(entries.map((entry) => entry.path));
      } catch (error) {
        console.error("Failed to enqueue compression:", error);
        alert(t("file_list.error_operation", { error: String(error) }));
      }
    },
    [t]
  );

  const handleExtract = useCallback(
    async (entry: FileEntry) => {
      try {
        await enqueueExtractOperation(entry.path);
      } catch (error) {
        console.error("Failed to enqueue extraction:", error);
        alert(t("file_list.error_operation", { error: String(error) }));
      }
    },
    [t]
  );

  const handleCopyPath = useCallback(async (entry: FileEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
    } catch (e) {
      console.error("Failed to copy path:", e);
    }
  }, []);

  const handleNewFile = useCallback(async () => {
    try {
      const defaultName = t("file_list.untitled_file");
      const newPath = await invoke<string>("create_file", {
        path: `${currentPath}/${defaultName}`,
      });
      await onRefresh();
      onStartRename(newPath, defaultName);
    } catch (e) {
      console.error("Failed to create file:", e);
    }
  }, [currentPath, onRefresh, onStartRename, t]);

  const handleNewFolder = useCallback(async () => {
    try {
      const defaultName = t("file_list.untitled_folder");
      const newPath = await invoke<string>("create_directory", {
        path: `${currentPath}/${defaultName}`,
      });
      await onRefresh();
      onStartRename(newPath, defaultName);
    } catch (e) {
      console.error("Failed to create folder:", e);
    }
  }, [currentPath, onRefresh, onStartRename, t]);

  const handleOpenInTerminal = useCallback(async () => {
    try {
      await openWithService.openInDefaultTerminal(currentPath);
    } catch (e) {
      console.error("Failed to open terminal:", e);
    }
  }, [currentPath]);

  return {
    handleOpen,
    handleCopy,
    handleCut,
    handlePaste,
    handleDelete,
    handleCompress,
    handleExtract,
    handleCopyPath,
    handleNewFile,
    handleNewFolder,
    handleOpenInTerminal,
    handleMove: useCallback(
      async (sourcePath: string, targetPath: string) => {
        try {
          await enqueueFileOperation({
            kind: "move",
            paths: [sourcePath],
            destDir: targetPath,
          });
          // 目标窗口先立即获取一次最新状态；操作完成事件会再次刷新，
          // 源窗口则通过全局目录变化事件同步移除已移动项目。
          void onRefresh();
        } catch (error) {
          console.error("Failed to enqueue move operation:", error);
          alert(t("file_list.error_rename", { error: String(error) }));
        }
      },
      [onRefresh, t]
    ),
  };
}
