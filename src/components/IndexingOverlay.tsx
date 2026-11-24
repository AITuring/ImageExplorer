import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { triggerIconRefresh } from "@/lib/iconCache";

interface IndexStatus {
  is_building: boolean;
  file_count: number;
  last_build_failed: boolean;
  last_build_error: string | null;
}

export function IndexingOverlay() {
  const { t } = useTranslation();
  const [isIndexing, setIsIndexing] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    // 组件挂载时检查一次索引状态
    invoke<IndexStatus>("get_index_status")
      .then((status) => {
        if (status.is_building) {
          setIsIndexing(true);
          setFileCount(status.file_count);
        }
      })
      .catch(console.error);

    // 监听索引状态变化
    const unlistenStatus = listen<string>("index-status", (event) => {
      if (event.payload === "building") {
        setIsIndexing(true);
      } else if (event.payload === "ready") {
        // 触发全局图标刷新
        triggerIconRefresh();

        // 延迟关闭，让用户看到完成状态
        closeTimer = setTimeout(() => {
          setIsIndexing(false);
          closeTimer = null;
        }, 2000);
      } else if (event.payload === "failed") {
        // 后台索引失败时静默结束提示，不再弹出打扰用户的权限/失败浮窗
        setIsIndexing(false);
      }
    });

    // 监听索引进度更新
    const unlistenProgress = listen<number>("index-progress", (event) => {
      setFileCount(event.payload);
    });

    return () => {
      unlistenStatus
        .then((fn) => fn())
        .catch((e) => {
          if (!String(e).includes("undefined is not an object")) {
            console.warn("Failed to unlisten index-status", e);
          }
        });
      unlistenProgress
        .then((fn) => fn())
        .catch((e) => {
          if (!String(e).includes("undefined is not an object")) {
            console.warn("Failed to unlisten index-progress", e);
          }
        });
      if (closeTimer) clearTimeout(closeTimer);
    };
  }, []);

  if (!isIndexing || dismissed) return null;

  return (
    <div className="animate-in slide-in-from-bottom-4 fixed right-4 bottom-4 z-50">
      <div className="bg-card border-border flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg">
        <Loader2 className="text-primary h-5 w-5 animate-spin" />
        <div className="min-w-0 text-sm">
          <p className="text-foreground font-medium">{t("indexing.title", "正在构建索引")}</p>
          <p className="text-muted-foreground text-xs">
            {fileCount > 0
              ? t("indexing.indexed", { count: fileCount })
              : t("indexing.scanning", "正在扫描文件...")}
          </p>
        </div>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground ml-2 self-start rounded p-1"
          onClick={() => setDismissed(true)}
          aria-label={t("indexing.dismiss")}
          title={t("indexing.dismiss")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
