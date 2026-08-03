import { useMemo } from "react";
import { Check, CircleAlert, Clock3, Copy, FolderInput, Trash2, Undo2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { FileOperationSnapshot } from "@/types";
import { isTerminalOperationStatus, useOperationCenter } from "@/hooks/useOperationCenter";

function itemName(path: string | null): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function OperationIcon({ kind }: { kind: FileOperationSnapshot["kind"] }) {
  if (kind === "copy") return <Copy className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />;
  if (kind === "move") {
    return <FolderInput className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />;
  }
  return <Trash2 className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />;
}

function progressPercent(operation: FileOperationSnapshot): number {
  if (operation.status === "completed") return 100;
  if (operation.total_items === 0) return 0;
  return Math.min(
    100,
    Math.round(
      ((operation.completed_items + operation.failed_items + operation.skipped_items) /
        operation.total_items) *
        100
    )
  );
}

function OperationRow({
  operation,
  onCancel,
  onClear,
  onUndo,
}: {
  operation: FileOperationSnapshot;
  onCancel: (id: string) => void;
  onClear: (id: string) => void;
  onUndo: (id: string) => void;
}) {
  const { t } = useTranslation();
  const terminal = isTerminalOperationStatus(operation.status);
  const percent = progressPercent(operation);
  const statusKey = `operations.status_${operation.status}`;
  const canUndo = operation.undo_status === "available" || operation.undo_status === "failed";
  const undoInProgress = operation.undo_status === "queued" || operation.undo_status === "running";
  const canClear = terminal && !undoInProgress;

  return (
    <div className="border-border/50 space-y-2 border-b px-3 py-3 last:border-b-0">
      <div className="flex items-start gap-2">
        <OperationIcon kind={operation.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium">{t(`operations.kind_${operation.kind}`)}</span>
            <span className="text-muted-foreground text-xs">
              {operation.completed_items + operation.failed_items + operation.skipped_items}/
              {operation.total_items}
            </span>
          </div>
          <div
            className="text-muted-foreground mt-0.5 truncate text-xs"
            title={operation.current_item || undefined}
          >
            {operation.current_item ? itemName(operation.current_item) : t(statusKey)}
          </div>
        </div>
        {terminal ? (
          operation.status === "failed" ? (
            <CircleAlert className="text-destructive h-4 w-4 shrink-0" />
          ) : operation.status === "completed" ? (
            <Check className="h-4 w-4 shrink-0 text-green-500" />
          ) : (
            <X className="text-muted-foreground h-4 w-4 shrink-0" />
          )
        ) : (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-8 min-w-8 items-center justify-center rounded"
            onClick={() => onCancel(operation.id)}
            aria-label={t("operations.cancel")}
            title={t("operations.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="bg-muted h-1.5 overflow-hidden rounded-full" aria-hidden="true">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            operation.status === "failed" ? "bg-destructive" : "bg-primary"
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      {operation.errors.length > 0 && (
        <p className="text-destructive line-clamp-2 text-xs" title={operation.errors.join("\n")}>
          {operation.errors[0]}
        </p>
      )}

      {canUndo && (
        <button
          type="button"
          className="text-primary hover:text-primary/80 inline-flex min-h-8 items-center gap-1 text-xs"
          onClick={() => onUndo(operation.id)}
          aria-label={t("operations.undo")}
          title={t("operations.undo")}
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          {operation.undo_status === "failed" ? t("operations.undo_retry") : t("operations.undo")}
        </button>
      )}

      {operation.undo_status === "queued" || operation.undo_status === "running" ? (
        <p className="text-muted-foreground text-xs">{t("operations.undo_in_progress")}</p>
      ) : operation.undo_status === "completed" ? (
        <p className="text-muted-foreground text-xs">{t("operations.undo_completed")}</p>
      ) : null}

      {canClear && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center text-xs"
          onClick={() => onClear(operation.id)}
        >
          {t("operations.clear")}
        </button>
      )}
    </div>
  );
}

export function OperationCenter() {
  const { t } = useTranslation();
  const { operations, cancelOperation, undoOperation, clearOperation, clearCompleted } =
    useOperationCenter();
  const activeCount = useMemo(
    () => operations.filter((operation) => !isTerminalOperationStatus(operation.status)).length,
    [operations]
  );

  if (operations.length === 0) return null;

  return (
    <section
      className="bg-popover text-popover-foreground fixed right-4 bottom-4 z-50 w-[360px] overflow-hidden rounded-xl border shadow-xl"
      aria-label={t("operations.title")}
    >
      <header className="border-border/50 flex items-center justify-between border-b px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Clock3 className="text-muted-foreground h-4 w-4" />
          {t("operations.title")}
          {activeCount > 0 && (
            <span className="bg-primary/15 text-primary rounded-full px-1.5 py-0.5 text-xs">
              {activeCount}
            </span>
          )}
        </div>
        {operations.some(
          (operation) =>
            isTerminalOperationStatus(operation.status) &&
            operation.undo_status !== "queued" &&
            operation.undo_status !== "running"
        ) && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center text-xs"
            onClick={clearCompleted}
          >
            {t("operations.clear_completed")}
          </button>
        )}
      </header>
      <div className="max-h-[min(60vh,420px)] overflow-y-auto">
        {operations.map((operation) => (
          <OperationRow
            key={operation.id}
            operation={operation}
            onCancel={cancelOperation}
            onClear={clearOperation}
            onUndo={undoOperation}
          />
        ))}
      </div>
    </section>
  );
}
