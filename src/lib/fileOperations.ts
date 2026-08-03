import { invoke } from "@tauri-apps/api/core";
import type {
  FileOperationConflict,
  FileOperationConflictPolicy,
  FileOperationKind,
} from "@/types";
import {
  useOperationConflict,
  type FileOperationConflictDecision,
} from "@/stores/operationConflict";

interface EnqueueFileOperationOptions {
  kind: Exclude<FileOperationKind, "delete">;
  paths: string[];
  destDir: string;
}

async function resolveConflicts(
  kind: EnqueueFileOperationOptions["kind"],
  paths: string[],
  destDir: string
): Promise<FileOperationConflictDecision> {
  const conflicts = await invoke<FileOperationConflict[]>("get_file_operation_conflicts", {
    paths,
    destDir,
  });
  const relevantConflicts = conflicts.filter(
    (conflict) => !(kind === "move" && conflict.source === conflict.destination)
  );
  if (relevantConflicts.length === 0) return "keep_both";
  return useOperationConflict.getState().enqueue(kind, relevantConflicts);
}

export async function enqueueFileOperation({ kind, paths, destDir }: EnqueueFileOperationOptions) {
  const decision = await resolveConflicts(kind, paths, destDir);
  if (decision === "cancel") return null;

  const command = kind === "copy" ? "start_copy_operation" : "start_move_operation";
  return invoke<string>(command, {
    paths,
    destDir,
    conflictPolicy: decision as FileOperationConflictPolicy,
  });
}
