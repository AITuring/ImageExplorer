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

function parentPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : path.slice(0, 1);
}

function baseName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(separatorIndex + 1);
}

function joinPath(parent: string, name: string): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]$/, "")}${separator}${name}`;
}

export function enqueueCompressOperation(paths: string[]) {
  if (paths.length === 0) return Promise.resolve(null);
  const parent = parentPath(paths[0]);
  const archiveName = paths.length === 1 ? `${baseName(paths[0])}.zip` : "Archive.zip";
  return invoke<string>("start_compress_operation", {
    paths,
    destPath: joinPath(parent, archiveName),
  });
}

export function enqueueExtractOperation(archivePath: string) {
  const name = baseName(archivePath).replace(/\.zip$/i, "") || "Extracted";
  return invoke<string>("start_extract_operation", {
    archivePath,
    destDir: joinPath(parentPath(archivePath), name),
  });
}
