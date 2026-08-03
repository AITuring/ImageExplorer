import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useOperationConflict,
  type FileOperationConflictDecision,
} from "@/stores/operationConflict";

function itemName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function OperationConflictDialog() {
  const pending = useOperationConflict((state) => state.pending);
  const resolvePending = useOperationConflict((state) => state.resolvePending);

  const open = pending !== null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && resolvePending("cancel")}>
      <DialogContent className="max-w-xl">
        {pending && (
          <ConflictDialogBody key={pending.id} pending={pending} onResolve={resolvePending} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConflictDialogBody({
  pending,
  onResolve,
}: {
  pending: NonNullable<ReturnType<typeof useOperationConflict.getState>["pending"]>;
  onResolve: (decision: FileOperationConflictDecision) => void;
}) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<FileOperationConflictDecision>("keep_both");

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
          {t("operations.conflict_title")}
        </DialogTitle>
        <DialogDescription>
          {t("operations.conflict_description", { count: pending.conflicts.length })}
        </DialogDescription>
      </DialogHeader>

      <div className="bg-muted/40 max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
        {pending.conflicts.slice(0, 8).map((conflict) => (
          <div key={`${conflict.source}:${conflict.destination}`} className="min-w-0 text-sm">
            <div className="truncate font-medium" title={conflict.source}>
              {itemName(conflict.source)}
            </div>
            <div className="text-muted-foreground truncate text-xs" title={conflict.destination}>
              {t("operations.conflict_existing", { path: itemName(conflict.destination) })}
            </div>
          </div>
        ))}
        {pending.conflicts.length > 8 && (
          <p className="text-muted-foreground text-xs">
            {t("operations.conflict_more", { count: pending.conflicts.length - 8 })}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("operations.conflict_action")}</legend>
        {(
          [
            ["keep_both", "conflict_keep_both"],
            ["replace", "conflict_replace"],
            ["skip", "conflict_skip"],
          ] as const
        ).map(([value, labelKey]) => (
          <label
            key={value}
            className="hover:bg-accent flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2"
          >
            <input
              type="radio"
              name="operation-conflict-policy"
              value={value}
              checked={decision === value}
              onChange={() => setDecision(value)}
              className="mt-1"
            />
            <span className="text-sm">{t(`operations.${labelKey}`)}</span>
          </label>
        ))}
      </fieldset>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onResolve("cancel")}>
          {t("operations.conflict_cancel")}
        </Button>
        <Button type="button" onClick={() => onResolve(decision)}>
          {t("operations.conflict_continue")}
        </Button>
      </DialogFooter>
    </>
  );
}
