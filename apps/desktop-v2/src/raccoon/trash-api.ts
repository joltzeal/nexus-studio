import type { TrashEntry } from "../entities/trash/model/types";
import type { ProfileMeta } from "../entities/profile/model/types";
import { useProfile } from "../entities/profile/lib/useProfile";
import { nativeApi } from "./api";
import { workspace } from "./store";

export function nativeTrashConnection(): string {
  const id = workspace.state.connectionId;
  if (!id) throw new Error("请先选择 Workspace");
  return id;
}

function entry(value: unknown): TrashEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("回收站条目返回格式无效");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || typeof row.folder !== "string"
    || typeof row.deleted_at !== "number" || !Number.isSafeInteger(row.deleted_at) || row.deleted_at < 0
    || row.expires_at !== null || row.size_bytes !== null) throw new Error("回收站条目返回格式无效");
  return { id: row.id, name: row.name, folder: row.folder, deleted_at: row.deleted_at, expires_at: null, size_bytes: null };
}

export const nativeTrashApi = {
  async list(connectionId = nativeTrashConnection()): Promise<TrashEntry[]> {
    const value = await nativeApi.call("browser_trash_list", { connectionId });
    if (!Array.isArray(value)) throw new Error("回收站列表返回格式无效");
    const entries = value.map(entry);
    if (new Set(entries.map((row) => row.id)).size !== entries.length) throw new Error("回收站包含重复 Profile ID");
    return entries;
  },
  async move(ids: string[], connectionId = nativeTrashConnection()): Promise<string[]> {
    const expected = [...new Set(ids)];
    const value = await nativeApi.call("browser_profile_trash", { connectionId, ids: expected });
    if (!Array.isArray(value) || value.length !== expected.length || new Set(value).size !== expected.length
      || value.some((id: unknown) => typeof id !== "string" || !expected.includes(id))) throw new Error("移入回收站回执无效，请刷新核对");
    return value as string[];
  },
  async restore(id: string, connectionId = nativeTrashConnection()): Promise<{ id: string; name: string }> {
    const value = await nativeApi.call("browser_trash_restore", { connectionId, id });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("恢复 Profile 回执无效");
    const row = value as Record<string, unknown>;
    if (row.id !== id || typeof row.name !== "string") throw new Error("恢复 Profile 回执无效");
    return { id, name: row.name };
  },
  async purge(id: string, connectionId = nativeTrashConnection()): Promise<void> {
    await nativeApi.call("browser_trash_purge", { connectionId, id });
  },
  async empty(ids: string[], connectionId = nativeTrashConnection()): Promise<number> {
    const value = await nativeApi.call("browser_trash_empty", { connectionId, ids });
    if (value !== new Set(ids).size) throw new Error("清空回收站回执无效，请刷新核对");
    return value as number;
  },
};

/** The imported Undo API requires the original table metadata, read back after restore. */
export async function restoreNativeTrashProfile(id: string): Promise<ProfileMeta> {
  const connectionId = nativeTrashConnection();
  await nativeTrashApi.restore(id, connectionId);
  if (workspace.state.connectionId !== connectionId) throw new Error("Workspace 已切换，请在原 Workspace 核对恢复结果");
  await workspace.refresh();
  if (workspace.state.connectionId !== connectionId) throw new Error("Workspace 已切换，请在原 Workspace 核对恢复结果");
  const profile = useProfile.getState().profiles.find((row) => row.id === id);
  if (!profile) throw new Error("Profile 已恢复，列表读取待核对，请刷新");
  return profile;
}
