import { create } from "zustand";
import type {
  FileOperationConflict,
  FileOperationConflictPolicy,
  FileOperationKind,
} from "@/types";

export type FileOperationConflictDecision = FileOperationConflictPolicy | "cancel";

interface ConflictRequest {
  id: number;
  kind: FileOperationKind;
  conflicts: FileOperationConflict[];
  resolve: (decision: FileOperationConflictDecision) => void;
}

interface OperationConflictState {
  pending: ConflictRequest | null;
  queue: ConflictRequest[];
  enqueue: (
    kind: FileOperationKind,
    conflicts: FileOperationConflict[]
  ) => Promise<FileOperationConflictDecision>;
  resolvePending: (decision: FileOperationConflictDecision) => void;
}

let nextRequestId = 1;

export const useOperationConflict = create<OperationConflictState>((set) => ({
  pending: null,
  queue: [],
  enqueue: (kind, conflicts) =>
    new Promise<FileOperationConflictDecision>((resolve) => {
      const request: ConflictRequest = {
        id: nextRequestId++,
        kind,
        conflicts,
        resolve,
      };
      set((state) => (state.pending ? { queue: [...state.queue, request] } : { pending: request }));
    }),
  resolvePending: (decision) =>
    set((state) => {
      if (!state.pending) return state;
      state.pending.resolve(decision);
      const [next, ...rest] = state.queue;
      return { pending: next ?? null, queue: rest };
    }),
}));
