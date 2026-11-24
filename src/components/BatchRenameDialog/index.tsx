import { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types";
import { getCachedPhotoMetadata } from "@/lib/photoMetadata";
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

type RenameMode = "replace" | "regex" | "prefix" | "suffix" | "counter" | "template" | "case";
type CasePreset = "lower" | "upper" | "title";
const DEFAULT_COUNTER_PATTERN = "{name}_{counter}";
const DEFAULT_TEMPLATE_PATTERN = "{date}_{model}_{counter:03}";
const TEMPLATE_TOKENS = ["{date}", "{model}", "{iso}", "{focal}", "{counter:03}", "{name}"];

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function sanitizeToken(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function formatYmdFromEntry(file: FileEntry, capturedAt?: string | null): string {
  if (capturedAt) {
    const match = capturedAt.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
    if (match) return `${match[1]}${match[2]}${match[3]}`;
  }
  const d = new Date((file.modified ?? 0) * 1000);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function toTitleCase(input: string): string {
  let out = "";
  let cap = true;
  for (const ch of input) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out += cap ? ch.toUpperCase() : ch.toLowerCase();
      cap = false;
    } else {
      out += ch;
      cap = true;
    }
  }
  return out;
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
  const [casePreset, setCasePreset] = useState<CasePreset>("lower");
  const [isRenaming, setIsRenaming] = useState(false);

  const { previews, regexError } = useMemo(() => {
    let compiledRegex: RegExp | null = null;
    let err: string | null = null;
    if (mode === "regex" && findText) {
      try {
        compiledRegex = new RegExp(findText, "g");
      } catch (e) {
        err = String(e);
      }
    }

    const items = selectedFiles.map((file, i) => {
      const hasExtension = !file.is_dir && file.extension != null;
      const ext = hasExtension ? `.${file.extension}` : "";
      const stem = hasExtension ? file.name.slice(0, -ext.length) : file.name;

      let newName: string;
      switch (mode) {
        case "replace":
          newName = !findText ? file.name : `${replaceAllLiteral(stem, findText, pattern)}${ext}`;
          break;
        case "regex":
          newName = !compiledRegex ? file.name : `${stem.replace(compiledRegex, pattern)}${ext}`;
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
        case "template": {
          const tpl = pattern || DEFAULT_TEMPLATE_PATTERN;
          const meta = !file.is_dir ? getCachedPhotoMetadata(file) : null;
          const dateStr = formatYmdFromEntry(file, meta?.capturedAt);
          const modelStr = meta?.model ? sanitizeToken(meta.model) || "Camera" : "Camera";
          const isoStr = meta?.iso ? `ISO${sanitizeToken(meta.iso)}` : "ISO";
          const focalNum = meta?.focalLength ? Number.parseFloat(meta.focalLength) : Number.NaN;
          const focalStr = Number.isFinite(focalNum) ? `${Math.round(focalNum)}mm` : "0mm";
          const counterPlain = String(i + 1);
          const counterPadded = String(i + 1).padStart(3, "0");
          let rendered = replaceAllLiteral(tpl, "{counter:03}", counterPadded);
          rendered = replaceAllLiteral(rendered, "{counter}", counterPlain);
          rendered = replaceAllLiteral(rendered, "{name}", stem);
          rendered = replaceAllLiteral(rendered, "{date}", dateStr);
          rendered = replaceAllLiteral(rendered, "{model}", modelStr);
          rendered = replaceAllLiteral(rendered, "{iso}", isoStr);
          rendered = replaceAllLiteral(rendered, "{focal}", focalStr);
          newName = `${rendered}${ext}`;
          break;
        }
        case "case": {
          const transformed =
            casePreset === "upper"
              ? stem.toUpperCase()
              : casePreset === "title"
                ? toTitleCase(stem)
                : stem.toLowerCase();
          newName = `${transformed}${ext}`;
          break;
        }
      }
      return { original: file.name, newName, path: file.path };
    });

    return { previews: items, regexError: err };
  }, [selectedFiles, mode, pattern, findText, casePreset]);

  const handleSubmit = async () => {
    setIsRenaming(true);
    try {
      const paths = selectedFiles.map((f) => f.path);
      const submittedPattern =
        mode === "case"
          ? casePreset
          : mode === "counter" && !pattern
            ? DEFAULT_COUNTER_PATTERN
            : mode === "template" && !pattern
              ? DEFAULT_TEMPLATE_PATTERN
              : pattern;
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
    { value: "regex", label: t("file_list.rename_mode_regex") },
    { value: "template", label: t("file_list.rename_mode_template") },
    { value: "case", label: t("file_list.rename_mode_case") },
    { value: "prefix", label: t("file_list.rename_mode_prefix") },
    { value: "suffix", label: t("file_list.rename_mode_suffix") },
    { value: "counter", label: t("file_list.rename_mode_counter") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("file_list.batch_rename_title", { count: selectedFiles.length })}
          </DialogTitle>
          <DialogDescription>{t("file_list.batch_rename_desc")}</DialogDescription>
        </DialogHeader>

        {/* 模式选择 */}
        <div className="flex flex-wrap gap-1.5">
          {modes.map((m) => (
            <button
              type="button"
              key={m.value}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                mode === m.value
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-muted hover:bg-accent"
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
          {(mode === "replace" || mode === "regex") && (
            <Input
              aria-label={t("file_list.rename_find_placeholder")}
              placeholder={
                mode === "regex"
                  ? t("file_list.rename_regex_find_placeholder")
                  : t("file_list.rename_find_placeholder")
              }
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
            />
          )}
          {mode === "case" ? (
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["lower", "file_list.rename_case_lower"],
                  ["upper", "file_list.rename_case_upper"],
                  ["title", "file_list.rename_case_title"],
                ] as const
              ).map(([preset, labelKey]) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setCasePreset(preset)}
                  className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    casePreset === preset
                      ? "border-primary bg-primary/15 text-primary font-medium"
                      : "border-border/70 text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          ) : (
            <Input
              aria-label={
                mode === "counter"
                  ? t("file_list.rename_counter_placeholder")
                  : mode === "template"
                    ? DEFAULT_TEMPLATE_PATTERN
                    : t("file_list.rename_pattern_placeholder")
              }
              placeholder={
                mode === "counter"
                  ? t("file_list.rename_counter_placeholder")
                  : mode === "template"
                    ? DEFAULT_TEMPLATE_PATTERN
                    : mode === "regex"
                      ? t("file_list.rename_regex_replace_placeholder")
                      : t("file_list.rename_pattern_placeholder")
              }
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          )}
          {mode === "template" && (
            <div className="flex flex-wrap items-center gap-1">
              {TEMPLATE_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => setPattern((prev) => `${prev}${prev ? "_" : ""}${token}`)}
                  className="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {token}
                </button>
              ))}
            </div>
          )}
          {regexError && <p className="text-destructive text-xs">{regexError}</p>}
        </div>

        {/* 预览 */}
        <div className="border-border max-h-48 overflow-y-auto rounded-md border">
          {previews.map((p) => (
            <div
              key={p.path}
              className="border-border/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
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
            disabled={
              isRenaming ||
              selectedFiles.length === 0 ||
              ((mode === "replace" || mode === "regex") && !findText) ||
              Boolean(regexError)
            }
          >
            {isRenaming ? t("common.loading") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
