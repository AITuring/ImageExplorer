export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  extension: string | null;
  readonly: boolean;
  /** Whether the item is hidden by the filesystem or filename convention. */
  is_hidden: boolean;
  /** Whether the item is a symbolic link. */
  is_symlink?: boolean;
  /** Resolved symbolic-link target, when available. */
  symlink_target?: string | null;
  /** Whether the item is a platform package such as a .app bundle. */
  is_package?: boolean;
  /** Package extension without the leading dot, when this is a package. */
  package_type?: string | null;
  /** Extended metadata. Values are seconds since the Unix epoch where applicable. */
  created?: number | null;
  accessed?: number | null;
  mode?: number | null;
  uid?: number | null;
  gid?: number | null;
  file_attributes?: number | null;
}

export interface InstalledApp {
  name: string;
  bundle_id: string;
  path: string;
  icon_path: string | null;
  icon_base64?: string;
  is_terminal: boolean;
}

export interface SearchResult {
  name: string;
  path: string;
  is_dir: boolean;
  extension?: string;
  is_hidden?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
}

export type FileOperationKind = "copy" | "move" | "delete";
export type FileOperationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type FileOperationConflictPolicy = "keep_both" | "replace" | "skip";
export type FileOperationUndoStatus =
  | "none"
  | "available"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface FileOperationConflict {
  source: string;
  destination: string;
  source_is_dir: boolean;
  destination_is_dir: boolean;
}

export interface FileOperationSnapshot {
  id: string;
  kind: FileOperationKind;
  status: FileOperationStatus;
  total_items: number;
  completed_items: number;
  failed_items: number;
  skipped_items: number;
  total_bytes: number;
  completed_bytes: number;
  current_item: string | null;
  errors: string[];
  cancel_requested: boolean;
  undo_status: FileOperationUndoStatus;
  started_at: number;
  finished_at: number | null;
}

export interface FolderItem {
  name: string;
  path: string;
  children?: FolderItem[];
}

export interface MountedVolume {
  name: string;
  path: string;
  readonly: boolean;
}

// UI 组件相关类型
export interface SysIcon {
  type: "path" | "ext" | "folder" | "sfsymbol";
  value?: string;
}

export interface SmartIconProps {
  icon?: React.ElementType;
  className?: string;
  sysIcon?: SysIcon;
}

export interface MenuItemProps {
  icon?: React.ReactNode;
  fallbackIcon?: React.ComponentType<{ className?: string }>;
  sysIcon?: SysIcon;
  label: string;
  shortcut?: string;
  onClick: () => void;
  destructive?: boolean;
}

// Context Menu 相关类型
export type ContextMenuType = "file" | "folder" | "text-input" | "empty-area" | "sidebar-item";

export interface TextInputActions {
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

export interface FileActions {
  onOpen: (entry: FileEntry) => void;
  onOpenInNewTab?: (entry: FileEntry) => void;
  onCopy: (entries: FileEntry[]) => void;
  onCut: (entries: FileEntry[]) => void;
  onPaste: () => void;
  onCopyPath: (entry: FileEntry) => void;
  onDelete: (entries: FileEntry[]) => void;
  onRename?: (entry: FileEntry) => void;
  onGoToLocation?: (entry: FileEntry) => void;
  onBatchRename?: (entries: FileEntry[]) => void;
  currentPath: string;
}

export interface EmptyAreaActions {
  onPaste: () => void;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onOpenInTerminal: () => void;
  onSort: (field: SortField) => void;
  onArrange: () => void;
  onArrangeBy: (field: SortField) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  currentPath: string;
}

export type SortField = "name" | "kind" | "size" | "date" | "created";
export type SortDirection = "asc" | "desc";

export interface SidebarItemActions {
  onOpen: () => void;
  onOpenInTerminal: () => void;
  path: string;
  name: string;
}
