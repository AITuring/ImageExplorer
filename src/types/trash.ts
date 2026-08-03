export interface TrashEntry {
  id: string;
  name: string;
  original_path: string | null;
  size: number | null;
  deleted_at: number | null;
  can_restore: boolean;
}
