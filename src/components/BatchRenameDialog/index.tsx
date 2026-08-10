import { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type RenameMode = "replace" | "prefix" | "suffix" | "counter";
const DEFAULT_COUNTER_PATTERN = "{name}_{counter}";

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

interface BatchRenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedFiles: FileEntry[];
  onComplete: () => void;
}

interface BatchRenameResult {
  success: number;
  failed: number;
  errors: string[];
}

export function BatchRenameDialog({
  open,
  onOpenChange,
  selectedFiles,
  onComplete,
}: BatchRenameDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<RenameMode>("replace");
  const [pattern, setPattern] = useState("");
  const [findText, setFindText] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  // 预览新文件名
  const previews = useMemo(() => {
    return selectedFiles.map((file, i) => {
      const hasExtension = file.extension != null;
      const ext = hasExtension ? `.${file.extension}` : "";
      const stem = hasExtension ? file.name.slice(0, -ext.length) : file.name;

      let newName: string;
      switch (mode) {
        case "replace":
          if (!findText) {
            newName = file.name;
          } else {
            newName = `${replaceAllLiteral(stem, findText, pattern)}${ext}`;
          }
          break;
        case "prefix":
          newName = `${pattern}${stem}${ext}`;
          break;
        case "suffix":
          newName = `${stem}${pattern}${ext}`;
          break;
        case "counter": {
          const counter = String(i + 1);
          const withCounter = replaceAllLiteral(
            pattern || DEFAULT_COUNTER_PATTERN,
            "{counter}",
            counter
          );
          const name = replaceAllLiteral(withCounter, "{name}", stem);
          newName = `${name}${ext}`;
          break;
        }
      }
      return { original: file.name, newName, path: file.path };
    });
  }, [selectedFiles, mode, pattern, findText]);

  const handleSubmit = async () => {
    setIsRenaming(true);
    try {
      const paths = selectedFiles.map((f) => f.path);
      const submittedPattern = mode === "counter" && !pattern ? DEFAULT_COUNTER_PATTERN : pattern;
      const result = await invoke<BatchRenameResult>("batch_rename", {
        paths,
        pattern: submittedPattern,
        mode,
        find: findText || null,
      });

      if (result.failed > 0) {
        alert(
          t("file_list.batch_rename_partial", {
            success: result.success,
            failed: result.failed,
          }) +
            "\n" +
            result.errors.join("\n")
        );
        return;
      }

      onComplete();
      onOpenChange(false);
    } catch (e) {
      alert(String(e));
    } finally {
      setIsRenaming(false);
    }
  };

  const modes: { value: RenameMode; label: string }[] = [
    { value: "replace", label: t("file_list.rename_mode_replace") },
    { value: "prefix", label: t("file_list.rename_mode_prefix") },
    { value: "suffix", label: t("file_list.rename_mode_suffix") },
    { value: "counter", label: t("file_list.rename_mode_counter") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("file_list.batch_rename_title", { count: selectedFiles.length })}
          </DialogTitle>
          <DialogDescription>{t("file_list.batch_rename_desc")}</DialogDescription>
        </DialogHeader>

        {/* 模式选择 */}
        <div className="flex gap-2">
          {modes.map((m) => (
            <button
              type="button"
              key={m.value}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                mode === m.value ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent"
              }`}
              onClick={() => setMode(m.value)}
              aria-pressed={mode === m.value}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* 输入区域 */}
        <div className="space-y-2">
          {mode === "replace" && (
            <Input
              aria-label={t("file_list.rename_find_placeholder")}
              placeholder={t("file_list.rename_find_placeholder")}
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
            />
          )}
          <Input
            aria-label={
              mode === "counter"
                ? t("file_list.rename_counter_placeholder")
                : t("file_list.rename_pattern_placeholder")
            }
            placeholder={
              mode === "counter"
                ? t("file_list.rename_counter_placeholder")
                : t("file_list.rename_pattern_placeholder")
            }
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
        </div>

        {/* 预览 */}
        <div className="border-border max-h-48 overflow-y-auto rounded-md border">
          {previews.map((p) => (
            <div
              key={p.path}
              className="border-border/50 flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0"
            >
              <span className="text-muted-foreground min-w-0 flex-1 truncate">{p.original}</span>
              <span className="text-muted-foreground shrink-0">→</span>
              <span className="min-w-0 flex-1 truncate font-medium">{p.newName}</span>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isRenaming || selectedFiles.length === 0 || (mode === "replace" && !findText)}
          >
            {isRenaming ? t("common.loading") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
