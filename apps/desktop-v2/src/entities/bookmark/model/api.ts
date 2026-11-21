import { invoke } from "../../../shared/api/invoke";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { nativeBookmarkApi } from "../../../raccoon/shardbrowser-library-api";
import type { Bookmark } from "./types";

export const bookmarkList = () => isNativeRaccoon() ? nativeBookmarkApi.list() : invoke<Bookmark[]>("bookmark_list");
export const bookmarkSave = (entry: Bookmark) => isNativeRaccoon() ? nativeBookmarkApi.save(entry) : invoke<Bookmark>("bookmark_save", { entry });
export const bookmarkDelete = (id: string) => isNativeRaccoon() ? nativeBookmarkApi.remove(id) : invoke("bookmark_delete", { id });
export const bookmarkDeleteMany = (ids: string[]) => isNativeRaccoon() ? nativeBookmarkApi.removeMany(ids) : invoke("bookmark_delete_many", { ids });
