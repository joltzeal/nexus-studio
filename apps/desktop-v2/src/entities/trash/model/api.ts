import { invoke } from "../../../shared/api/invoke";
import type { ProfileMeta } from "../../profile/model/types";
import type { TrashEntry } from "./types";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { nativeTrashApi, restoreNativeTrashProfile } from "../../../raccoon/trash-api";

export const trashList = () => isNativeRaccoon() ? nativeTrashApi.list() : invoke<TrashEntry[]>("trash_list");
export const trashRestore = (id: string) => isNativeRaccoon() ? restoreNativeTrashProfile(id) : invoke<ProfileMeta>("trash_restore", { id });
export const trashPurge = (id: string) => isNativeRaccoon() ? nativeTrashApi.purge(id) : invoke("trash_purge", { id });
export const trashEmpty = async (ids?: string[]) => {
  if (!isNativeRaccoon()) return invoke<number>("trash_empty");
  if (!ids) throw new Error("清空回收站需要已确认的 Profile 列表");
  return nativeTrashApi.empty(ids);
};
