/**
 * TabBar 组件
 * 单一职责：Tab 栏容器，组合 TabItem 和 NewTabButton，处理拖拽排序
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useTabs } from "@/hooks/useTabs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { TabItem } from "./TabItem";
import { TabContextMenu } from "./TabContextMenu";
import { NewTabButton } from "./NewTabButton";

const TAB_DRAG_MIME = "application/x-imageexplorer-tab";
const TAB_DRAG_FALLBACK_MIME = "text/plain";

interface TabDragData {
  kind: "tab";
  tab: import("@/types/tabs").Tab;
  fromWindowId: string;
  index: number;
}

function readTabDragData(dataTransfer: DataTransfer): TabDragData | null {
  const raw = dataTransfer.getData(TAB_DRAG_MIME) || dataTransfer.getData(TAB_DRAG_FALLBACK_MIME);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as Partial<TabDragData>;
    if (data.kind !== "tab" || !data.tab || !data.fromWindowId || typeof data.index !== "number") {
      return null;
    }
    return data as TabDragData;
  } catch {
    return null;
  }
}

export function TabBar() {
  const {
    tabs,
    activeTabId,
    homePath,
    setActiveTab,
    closeTab,
    removeTab,
    closeOtherTabs,
    closeTabsToRight,
    addTab,
    addTransferredTab,
    duplicateTab,
    reorderTabs,
  } = useTabs();

  // 拖拽状态
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // 用于在拖拽结束时立即隐藏 Tab，避免浏览器原生的 "snap back" 动画
  const [hiddenTabId, setHiddenTabId] = useState<string | null>(null);
  // 标记 handleDrop 是否执行了有意义的操作（真实排序或跨窗口传输）
  const dropHandledRef = useRef(false);
  const acceptedTransferIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<{ tabId: string; fromWindowId: string }>(
        "tab-transfer-complete",
        (event) => {
          if (event.payload.fromWindowId === getCurrentWebviewWindow().label) {
            acceptedTransferIdsRef.current.add(event.payload.tabId);
          }
        }
      );
    };
    setup().catch((error) => console.error("Failed to listen for tab transfer completion:", error));
    return () => unlisten?.();
  }, []);

  const handleNewTab = () => {
    // 新建标签页默认打开主目录
    addTab(homePath);
  };

  // 使用 ref 追踪最新的 tabs，用于在异步操作中检查 tab 是否存在
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // 保存 Tab DOM 引用，用于在拖拽结束时立即操作样式
  const tabDomRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 拖拽开始
  const handleDragStart = useCallback(
    async (e: React.DragEvent, index: number) => {
      // 同步设置拖拽数据（必须在事件处理器的同步部分完成）
      e.dataTransfer.effectAllowed = "move";

      // 使用 Tauri 的实际窗口 label
      const windowId = getCurrentWebviewWindow().label;

      const dragData = {
        tab: tabs[index],
        fromWindowId: windowId,
        index,
      };

      const serialized = JSON.stringify({ kind: "tab", ...dragData });
      // text/plain 是跨 WebView/窗口时最稳定的回退格式。
      e.dataTransfer.setData(TAB_DRAG_MIME, serialized);
      e.dataTransfer.setData(TAB_DRAG_FALLBACK_MIME, serialized);
      setDragIndex(index);
      dropHandledRef.current = false; // 重置标记
    },
    [tabs]
  );

  // 拖拽经过
  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      // 明确告知浏览器这是一个有效的放置目标
      e.dataTransfer.dropEffect = "move";

      // 只有当不是自己时才更新 dragOverIndex
      if (dragIndex !== index) {
        setDragOverIndex(index);
      }
    },
    [dragIndex]
  );

  // 拖拽结束 - 检测是否拖出窗口边界或拖到其他窗口上
  const handleDragEnd = useCallback(
    async (e: React.DragEvent) => {
      const { clientX, clientY, screenX, screenY } = e;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // 检查是否拖出窗口边界
      const isOutOfBounds =
        clientX <= 0 || clientX >= windowWidth || clientY <= 0 || clientY >= windowHeight;

      if (dropHandledRef.current) {
        // handleDrop 已经执行了有意义的操作（真实排序或跨窗口传输）
        console.log("[TabBar] Drop was handled by handleDrop, resetting");
        dropHandledRef.current = false;
        setDragIndex(null);
        setDragOverIndex(null);
      } else if (dragIndex !== null) {
        // handleDrop 没有执行有意义的操作
        // 可能是：1) 拖到了另一个窗口上（包括重叠场景） 2) 拖到了空白区域 3) 取消拖拽
        const tab = tabs[dragIndex];
        console.log("[TabBar] Drop not meaningfully handled, checking for target window...");

        // 1. 同步立即隐藏该 Tab DOM，防止浏览器 "snap back" 动画
        const el = tabDomRefs.current.get(tab.id);
        if (el) {
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
        }

        // 2. 更新 React 状态
        setHiddenTabId(tab.id);

        setTimeout(async () => {
          const currentTabs = tabsRef.current;
          const stillExists = currentTabs.some((t) => t.id === tab.id);

          if (stillExists) {
            if (acceptedTransferIdsRef.current.delete(tab.id)) {
              // 目标窗口已经完成接收，源窗口由统一的 transfer-complete 监听负责关闭。
              setHiddenTabId(null);
              setDragIndex(null);
              setDragOverIndex(null);
              return;
            }
            const { windowManager } = await import("@/lib/windowManager");
            // 始终检查 drop 位置是否在已有窗口上（解决重叠窗口的场景）
            const targetWindowId = await windowManager.findWindowAtPosition(screenX, screenY);

            if (targetWindowId) {
              // 跨窗口转移（单 Tab 窗口也可以，源窗口会自动关闭）
              console.log("[TabBar] Transferring tab to existing window:", targetWindowId);
              await windowManager.transferTab(tab, targetWindowId, screenX, screenY);
              removeTab(tab.id);
            } else if (isOutOfBounds) {
              // 拖到空白区域，创建新窗口；单 Tab 窗口也支持脱离。
              console.log("[TabBar] Creating new window at screen position");
              try {
                await windowManager.createWindow({ tab, x: screenX - 500, y: screenY });
                removeTab(tab.id);
              } catch (error) {
                console.error("[TabBar] Failed to create detached tab window:", error);
                const restoreEl = tabDomRefs.current.get(tab.id);
                if (restoreEl) {
                  restoreEl.style.opacity = "";
                  restoreEl.style.pointerEvents = "";
                }
              }
            } else {
              // 取消拖拽，恢复 Tab 显示
              console.log("[TabBar] Drag cancelled, restoring tab");
              const restoreEl = tabDomRefs.current.get(tab.id);
              if (restoreEl) {
                restoreEl.style.opacity = "";
                restoreEl.style.pointerEvents = "";
              }
            }
          }

          setHiddenTabId(null);
          setDragIndex(null);
          setDragOverIndex(null);
        }, 50);
      } else {
        // 普通拖拽结束
        setDragIndex(null);
        setDragOverIndex(null);
      }
    },
    [dragIndex, tabs, removeTab]
  );

  // 放下
  const handleDrop = useCallback(
    async (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      e.stopPropagation(); // 防止冒泡到容器

      const data = readTabDragData(e.dataTransfer);
      if (!data) return;

      try {
        const { tab, fromWindowId, index: fromIndex } = data;

        // 使用 Tauri 的实际窗口 label
        const currentWindowId = getCurrentWebviewWindow().label;

        if (fromWindowId === currentWindowId) {
          // 同窗口排序
          if (fromIndex !== toIndex) {
            reorderTabs(fromIndex, toIndex);
            dropHandledRef.current = true; // 真实排序，标记为已处理
          }
          // fromIndex === toIndex: no-op，不标记 → handleDragEnd 会检查跨窗口
        } else {
          // 跨窗口移动：保留完整历史记录和原始 Tab ID。
          addTransferredTab(tab, toIndex);
          dropHandledRef.current = true; // 跨窗口传输，标记为已处理

          // 通知源窗口关闭 Tab
          const { emit } = await import("@tauri-apps/api/event");
          await emit("tab-transfer-complete", {
            tabId: tab.id,
            fromWindowId,
          });
        }
      } catch (err) {
        console.error("Failed to handle drop:", err);
      }

      setDragIndex(null);
      setDragOverIndex(null);
    },
    [reorderTabs, addTransferredTab]
  );

  // 复制路径
  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path);
  }, []);

  // 离开拖拽区域
  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      className="bg-muted/40 flex items-center gap-1 overflow-x-auto px-2 py-1.5"
      onDragLeave={handleDragLeave}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => handleDrop(e, tabs.length)}
    >
      {tabs.map((tab, index) => (
        <TabContextMenu
          key={tab.id}
          tab={tab}
          tabIndex={index}
          totalTabs={tabs.length}
          onClose={() => closeTab(tab.id)}
          onCloseOthers={() => closeOtherTabs(tab.id)}
          onCloseToRight={() => closeTabsToRight(tab.id)}
          onCopyPath={() => handleCopyPath(tab.path)}
          onDuplicate={() => duplicateTab(tab.id)}
          onNewTabLeft={() => addTab(homePath, undefined, index)}
          onNewTabRight={() => addTab(homePath, undefined, index + 1)}
        >
          <TabItem
            tab={tab}
            index={index}
            isActive={tab.id === activeTabId}
            onSelect={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            canClose={tabs.length > 1}
            isDragging={dragIndex === index}
            isHidden={hiddenTabId === tab.id}
            domRef={(el) => {
              if (el) tabDomRefs.current.set(tab.id, el);
              else tabDomRefs.current.delete(tab.id);
            }}
            dragOverIndex={dragOverIndex}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
          />
        </TabContextMenu>
      ))}
      <NewTabButton onClick={handleNewTab} />
    </div>
  );
}
