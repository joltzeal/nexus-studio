export type TrashEntry = {
  id: string;
  name: string;
  folder: string;
  /** Unix seconds. */
  deleted_at: number;
  /** Unix seconds for preview expiry. Native records remain until explicit purge. */
  expires_at: number | null;
  /** Null when disk usage has not been measured. */
  size_bytes: number | null;
};
