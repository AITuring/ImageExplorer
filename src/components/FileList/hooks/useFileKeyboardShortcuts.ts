import { useEffect, useRef } from "react";
import { FileEntry } from "@/types";
import { useClipboard } from "@/stores/clipboard";

interface UseFileKeyboardShortcutsOptions {
  editingPath: string | null;
  selectedPath: string | null;
  selectedPaths: string[];
  sortedEntries: FileEntry[];
  entries: FileEntry[];
  // 选择操作
  selectAll: (entries: FileEntry[]) => void;
  selectSingle: (path: string, index: number) => void;
  selectRange: (entries: FileEntry[], toIndex: number) => void;
  clearSelection: () => void;
  // 文件操作
  handleCopy: (entries: FileEntry[]) => void;
  handleCut: (entries: FileEntry[]) => void;
  handlePaste: () => Promise<void>;
  handleDelete: (entries: FileEntry[]) => Promise<void>;
  handleNewFile: () => Promise<void>;
  handleNewFolder: () => Promise<void>;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function useFileKeyboardShortcuts(options: UseFileKeyboardShortcutsOptions) {
  const clipboard = useClipboard();

  // 使用 ref 存储最新的 options，避免频繁重注册事件监听器
  const optionsRef = useRef(options);
  const clipboardRef = useRef(clipboard);

  useEffect(() => {
    optionsRef.current = options;
    clipboardRef.current = clipboard;
  });

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const {
        editingPath,
        selectedPath,
        selectedPaths,
        sortedEntries,
        entries,
        selectAll,
        selectSingle,
        selectRange,
        clearSelection,
        handleCopy,
        handleCut,
        handlePaste,
        handleDelete,
        handleNewFile,
        handleNewFolder,
      } = optionsRef.current;

      // 如果在编辑状态，不处理快捷键
      if (editingPath) return;

      // 让地址栏、搜索框以及重命名输入框保留浏览器原生的复制、粘贴、
      // 全选等行为，避免文件列表的全局快捷键抢走 Cmd+C/Cmd+V。
      if (isTextInputTarget(e.target)) return;

      // Cmd+A 全选
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        selectAll(entries);
      }
      // Esc 取消选择
      if (e.key === "Escape") {
        e.preventDefault();
        clearSelection();
      }
      // Cmd+Option+N 新建文件（使用 e.code 因为 macOS Option 会改变 e.key 的值）
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyN" && !e.shiftKey && e.altKey) {
        e.preventDefault();
        await handleNewFile();
      }
      // Cmd+Shift+N 新建文件夹
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && e.shiftKey) {
        e.preventDefault();
        await handleNewFolder();
      }
      // Cmd+C 复制
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedPaths.length > 0) {
        e.preventDefault();
        const selectedEntries = entries.filter((e) => selectedPaths.includes(e.path));
        if (selectedEntries.length > 0) handleCopy(selectedEntries);
      }
      // Cmd+X 剪切
      if ((e.metaKey || e.ctrlKey) && e.key === "x" && selectedPaths.length > 0) {
        e.preventDefault();
        const selectedEntries = entries.filter((e) => selectedPaths.includes(e.path));
        if (selectedEntries.length > 0) handleCut(selectedEntries);
      }
      // Cmd+V 粘贴
      if ((e.metaKey || e.ctrlKey) && e.key === "v" && clipboardRef.current.hasPending()) {
        e.preventDefault();
        await handlePaste();
      }
      // Delete 删除
      if (e.key === "Backspace" && e.metaKey && selectedPaths.length > 0) {
        e.preventDefault();
        const selectedEntries = entries.filter((e) => selectedPaths.includes(e.path));
        if (selectedEntries.length > 0) await handleDelete(selectedEntries);
      }
      // 方向键导航
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const currentIndex = selectedPath
          ? sortedEntries.findIndex((e) => e.path === selectedPath)
          : -1;
        let newIndex: number;
        if (e.key === "ArrowDown") {
          newIndex = currentIndex < sortedEntries.length - 1 ? currentIndex + 1 : currentIndex;
        } else {
          newIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        }
        if (newIndex >= 0 && newIndex < sortedEntries.length) {
          if (e.shiftKey) {
            // Shift+方向键：扩展选择
            selectRange(sortedEntries, newIndex);
          } else {
            // 普通方向键：单选
            selectSingle(sortedEntries[newIndex].path, newIndex);
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []); // 空依赖数组 — 通过 ref 获取最新值
}
