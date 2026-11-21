import { invoke } from "../../../shared/api/invoke";
import type { Tag } from "./types";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { nativeTagApi } from "../../../raccoon/tag-api";

/** The tags and which profiles carry them, as the backend keeps them (tags.rs). */
export type TagState = { tags: Tag[]; by_profile: Record<string, string[]> };

export const tagList = () => isNativeRaccoon() ? nativeTagApi.list() : invoke<TagState>("tag_list");
/** Adds the tag or changes the one with its id; a new one goes at `at` when given. */
export const tagSave = (tag: Tag, at?: number) => isNativeRaccoon() ? nativeTagApi.save(tag, at) : invoke<Tag>("tag_save", { tag, at: at ?? null });
/** Deletes the tag and takes it off every profile. */
export const tagDelete = (id: string) => isNativeRaccoon() ? nativeTagApi.remove(id) : invoke<null>("tag_delete", { id });
/** Gives each listed profile exactly these tags; an empty list clears it. */
export const tagAssign = (byProfile: Record<string, string[]>) => isNativeRaccoon() ? nativeTagApi.assign(byProfile) : invoke<null>("tag_assign", { byProfile });
/** Hands over the copy an older build kept in this window; false when the backend had tags already. */
export const tagImport = (state: TagState) => {
  if (isNativeRaccoon()) return Promise.reject(new Error("原生标签由 Rust 管理"));
  return invoke<boolean>("tag_import", { state });
};
