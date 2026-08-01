import {
  WebviewWindow,
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event";
import { nanoid } from "nanoid";
import type { Tab } from "@/types/tab";

// 窗口间传输 Tab 的事件 payload
export interface TabTransferPayload {
  fromWindowId: string;
  toWindowId: string; // 目标窗口 ID，或 "new" 表示创建新窗口
  tab: Tab;
  screenX: number; // 释放位置的屏幕坐标
  screenY: number;
}

// 窗口位置信息
export interface WindowInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

class WindowManager {
  private windowId: string;
  private unlistenFns: UnlistenFn[] = [];

  constructor() {
    // 使用 Tauri 的实际窗口 label，确保主窗口和子窗口 ID 统一
    this.windowId = getCurrentWebviewWindow().label;
    console.log("[WindowManager] Window ID:", this.windowId);
  }

  // 获取当前窗口 ID
  getWindowId(): string {
    return this.windowId;
  }

  // 获取从 URL 传递的初始路径
  getInitialPath(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get("path");
  }

  // 获取从 URL 传递的初始 Tab
  getInitialTab(): Tab | null {
    const params = new URLSearchParams(window.location.search);
    const rawTab = params.get("tab");
    if (rawTab) {
      // URLSearchParams 已经解码了一层；兼容旧版本留下的二次编码参数。
      const candidates = [rawTab];
      try {
        candidates.push(decodeURIComponent(rawTab));
      } catch {
        // 保留原始值继续尝试解析。
      }

      for (const candidate of candidates) {
        try {
          const tab = JSON.parse(candidate) as Tab;
          if (tab && typeof tab.path === "string" && Array.isArray(tab.history)) {
            return tab;
          }
        } catch {
          // 尝试下一个编码层级。
        }
      }
    }
    return null;
  }

  // 查找屏幕坐标所在的窗口（排除当前窗口）
  async findWindowAtPosition(screenX: number, screenY: number): Promise<string | null> {
    try {
      const allWindows = await getAllWebviewWindows();
      for (const win of allWindows) {
        // 跳过当前窗口
        if (win.label === this.windowId) continue;

        const pos = await win.outerPosition();
        const size = await win.outerSize();

        const inBoundsX = screenX >= pos.x && screenX <= pos.x + size.width;
        const inBoundsY = screenY >= pos.y && screenY <= pos.y + size.height;

        if (inBoundsX && inBoundsY) {
          console.log(
            `[WindowManager] Found target window: ${win.label} at (${pos.x},${pos.y} ${size.width}x${size.height})`
          );
          return win.label;
        }
      }
    } catch (e) {
      console.error("[WindowManager] Failed to find window at position:", e);
    }
    return null;
  }

  // 创建新窗口
  async createWindow(options?: {
    path?: string;
    tab?: Tab;
    x?: number;
    y?: number;
  }): Promise<WebviewWindow> {
    const newWindowId = `window-${nanoid(6)}`;
    const params = new URLSearchParams({ windowId: newWindowId });

    // 始终传递独立路径作为兜底，避免 Tab JSON 在跨窗口 URL 中解析失败时出现空白窗口。
    const initialPath = options?.path || options?.tab?.path;
    if (initialPath) {
      params.set("path", initialPath);
    }
    if (options?.tab) {
      // URLSearchParams 会负责编码，读取端会先拿到可直接 JSON.parse 的字符串。
      params.set("tab", JSON.stringify(options.tab));
    }

    // 使用当前窗口的完整应用 URL，避免动态 WebView 在开发环境中把相对
    // `index.html` 解析到错误的 origin，最终只显示透明空窗口。
    const appUrl = new URL(window.location.href);
    appUrl.search = params.toString();
    appUrl.hash = "";

    const windowOptions = {
      url: appUrl.toString(),
      title: "HyperExplorer",
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 600,
      x: options?.x,
      y: options?.y,
      transparent: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      // Keep HTML5 drag/drop available in dynamically-created windows.
      dragDropEnabled: false,
    } as const;

    // 等待新窗口完成 React 初始化。仅收到 Tauri 的 created 事件还不够，
    // 因为 WebView 可能已经创建但页面脚本仍加载失败，最终只显示透明空窗口。
    return new Promise((resolve, reject) => {
      let webview: WebviewWindow | undefined;
      let unlistenReady: UnlistenFn | undefined;
      let cancelTimeout = () => {};

      const cleanup = () => {
        unlistenReady?.();
        cancelTimeout();
      };

      const fail = async (error: Error) => {
        cleanup();
        try {
          await webview?.close();
        } catch {
          // 窗口可能在 WebView 初始化前就创建失败。
        }
        reject(error);
      };

      void listen<{ windowId: string }>("window-ready", (event) => {
        if (event.payload.windowId !== newWindowId || !webview) return;
        cleanup();
        resolve(webview);
      })
        .then((unlisten) => {
          unlistenReady = unlisten;
          webview = new WebviewWindow(newWindowId, windowOptions);
          void webview.once("tauri://error", (event) => {
            void fail(new Error(`Failed to create window: ${String(event.payload)}`));
          });

          const timeout = setTimeout(() => {
            void fail(new Error("Timed out waiting for the new window to finish loading"));
          }, 15_000);
          cancelTimeout = () => clearTimeout(timeout);
        })
        .catch((error) => {
          void fail(new Error(`Failed to listen for new window readiness: ${String(error)}`));
        });
    });
  }

  // 发送 Tab 到另一个窗口（或创建新窗口）
  async transferTab(
    tab: Tab,
    targetWindowId: string,
    screenX: number,
    screenY: number
  ): Promise<void> {
    const payload: TabTransferPayload = {
      fromWindowId: this.windowId,
      toWindowId: targetWindowId,
      tab,
      screenX,
      screenY,
    };

    await emit("tab-transfer", payload);
  }

  // 监听 Tab 接收事件
  async listenTabTransfer(callback: (payload: TabTransferPayload) => void): Promise<void> {
    const unlisten = await listen<TabTransferPayload>("tab-transfer", (event) => {
      // 只处理发给当前窗口的事件
      if (event.payload.toWindowId === this.windowId) {
        callback(event.payload);
      }
    });
    this.unlistenFns.push(unlisten);
  }

  // 清理监听器
  cleanup(): void {
    this.unlistenFns.forEach((fn) => fn());
    this.unlistenFns = [];
  }
}

// 单例导出
export const windowManager = new WindowManager();
