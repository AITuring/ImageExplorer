import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileOperationSnapshot } from "@/types";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function useOperationCenter() {
  const [operationsById, setOperationsById] = useState<Record<string, FileOperationSnapshot>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const stopListening = await listen<FileOperationSnapshot>(
          "file-operation-updated",
          (event) => {
            if (cancelled) return;
            setOperationsById((current) => ({
              ...current,
              [event.payload.id]: event.payload,
            }));
          }
        );
        if (cancelled) {
          stopListening();
          return;
        }
        unlisten = stopListening;

        const snapshots = await invoke<FileOperationSnapshot[]>("get_file_operations");
        if (!cancelled) {
          const loaded = Object.fromEntries(snapshots.map((snapshot) => [snapshot.id, snapshot]));
          // Listener updates happened after subscription and must not be
          // overwritten by an older snapshot captured during initialization.
          setOperationsById((current) => ({ ...loaded, ...current }));
        }
      } catch (error) {
        console.error("Failed to initialize operation center:", error);
      }
    };

    setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const operations = useMemo(
    () =>
      Object.values(operationsById).sort((a, b) => {
        if (a.started_at !== b.started_at) return b.started_at - a.started_at;
        return b.id.localeCompare(a.id);
      }),
    [operationsById]
  );

  const cancelOperation = useCallback(async (operationId: string) => {
    try {
      await invoke("cancel_file_operation", { operationId });
      setActionErrors((current) => {
        if (!(operationId in current)) return current;
        const next = { ...current };
        delete next[operationId];
        return next;
      });
    } catch (error) {
      console.error("Failed to cancel operation:", error);
      setActionErrors((current) => ({ ...current, [operationId]: String(error) }));
    }
  }, []);

  const retryOperation = useCallback(async (operationId: string) => {
    try {
      await invoke("retry_file_operation", { operationId });
      setActionErrors((current) => {
        if (!(operationId in current)) return current;
        const next = { ...current };
        delete next[operationId];
        return next;
      });
    } catch (error) {
      console.error("Failed to retry operation:", error);
      setActionErrors((current) => ({ ...current, [operationId]: String(error) }));
    }
  }, []);

  const undoOperation = useCallback(async (operationId: string) => {
    try {
      await invoke("undo_file_operation", { operationId });
      setActionErrors((current) => {
        if (!(operationId in current)) return current;
        const next = { ...current };
        delete next[operationId];
        return next;
      });
    } catch (error) {
      console.error("Failed to undo operation:", error);
      setActionErrors((current) => ({ ...current, [operationId]: String(error) }));
    }
  }, []);

  const clearOperation = useCallback(async (operationId: string) => {
    try {
      await invoke("clear_file_operation", { operationId });
      setOperationsById((current) => {
        const next = { ...current };
        delete next[operationId];
        return next;
      });
      setActionErrors((current) => {
        if (!(operationId in current)) return current;
        const next = { ...current };
        delete next[operationId];
        return next;
      });
    } catch (error) {
      console.error("Failed to clear operation:", error);
      setActionErrors((current) => ({ ...current, [operationId]: String(error) }));
    }
  }, []);

  const clearCompleted = useCallback(async () => {
    const completed = operations.filter(
      (operation) =>
        TERMINAL_STATUSES.has(operation.status) &&
        operation.undo_status !== "queued" &&
        operation.undo_status !== "running"
    );
    await Promise.all(completed.map((operation) => clearOperation(operation.id)));
  }, [clearOperation, operations]);

  return {
    operations,
    actionErrors,
    cancelOperation,
    retryOperation,
    undoOperation,
    clearOperation,
    clearCompleted,
  };
}

export function isTerminalOperationStatus(status: FileOperationSnapshot["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}
