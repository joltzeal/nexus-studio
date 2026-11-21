import type { Tag } from "../entities/tag/model/types";
import type { TagState } from "../entities/tag/model/api";
import { LABEL_COLORS } from "../shared/constants/labelColors";
import { nativeApi } from "./api";

let connectionId: string | null = null;
const listeners = new Set<() => void>();

export function nativeTagConnection(): string {
  if (!connectionId) throw new Error("请先选择 Workspace");
  return connectionId;
}

export function setNativeTagConnection(id: string | null): void {
  if (id === connectionId) return;
  connectionId = id;
  for (const listener of listeners) listener();
}

export function onNativeTagConnectionChanged(listener: () => void): void {
  listeners.add(listener);
}

function tagValue(value: unknown): Tag {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("标签返回格式无效");
  const row = value as Record<string, unknown>;
  const color = LABEL_COLORS.find((color) => color.id === row.color)?.id;
  if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name.trim() || row.name.length > 32 || !color) throw new Error("标签返回格式无效");
  return { id: row.id, name: row.name, color };
}

function tagState(value: unknown): TagState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("标签列表返回格式无效");
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.tags) || !row.by_profile || typeof row.by_profile !== "object" || Array.isArray(row.by_profile)) throw new Error("标签列表返回格式无效");
  const tags = row.tags.map(tagValue);
  const known = new Set(tags.map((tag) => tag.id));
  if (known.size !== tags.length) throw new Error("标签列表包含重复 ID");
  const by_profile: Record<string, string[]> = Object.create(null);
  for (const [id, ids] of Object.entries(row.by_profile)) {
    if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string" || !known.has(id))) throw new Error("Profile 标签引用无效");
    by_profile[id] = [...new Set(ids as string[])];
  }
  return { tags, by_profile };
}

export const nativeTagApi = {
  async list(id = nativeTagConnection()): Promise<TagState> {
    return tagState(await nativeApi.call("browser_tag_list", { connectionId: id }));
  },
  async save(tag: Tag, at?: number, id = nativeTagConnection()): Promise<Tag> {
    const saved = tagValue(await nativeApi.call("browser_tag_save", { connectionId: id, tag: tagValue(tag), at: at ?? null }));
    if (saved.id !== tag.id) throw new Error("标签保存返回了不同 ID");
    return saved;
  },
  async remove(tagId: string, id = nativeTagConnection()): Promise<void> {
    await nativeApi.call("browser_tag_delete", { connectionId: id, id: tagId });
  },
  async assign(byProfile: Record<string, string[]>, id = nativeTagConnection()): Promise<void> {
    await nativeApi.call("browser_tag_assign", { connectionId: id, byProfile });
  },
};
