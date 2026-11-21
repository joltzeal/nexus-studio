import type { NativeFolder } from "./api";
import { nativeError } from "./api";
import { workspace } from "./store";
import { DEFAULT_FOLDER_META, useFolderMeta, type FolderMeta } from "../entities/profile/lib/folderMeta";
import type { FolderDialogTarget } from "../entities/profile/lib/useProfileUi";

/** Project only the current connection's persisted Folder appearance. */
export function projectNativeFolderMeta(folders: NativeFolder[]) {
  useFolderMeta.setState({ byName: Object.fromEntries(folders.map((folder) => [folder.name, {
    color: folder.color ?? DEFAULT_FOLDER_META.color,
    icon: folder.icon ?? DEFAULT_FOLDER_META.icon,
  }])) });
}

/** Save the whole Folder before any dialog closes or Profiles are moved. */
export async function saveNativeFolder(target: FolderDialogTarget, name: string, meta: FolderMeta, createdId?: string): Promise<NativeFolder> {
  const connectionId = workspace.state.connectionId;
  const original = target.mode === "edit" ? workspace.state.folders.find((folder) => createdId ? folder.id === createdId : folder.name === target.name) : undefined;
  if (target.mode === "edit" && !original) throw new Error("Folder 不存在");
  try {
    const folder = await workspace.saveFolder(name, createdId ?? original?.id, meta);
    if (workspace.state.connectionId !== connectionId) throw new Error("Workspace 已切换，请重新打开 Folder");
    projectNativeFolderMeta(workspace.state.folders);
    return folder;
  } catch (cause) { throw nativeError(cause); }
}

export async function saveNativeFolderMeta(name: string, meta: FolderMeta): Promise<void> {
  await saveNativeFolder({ mode: "edit", name }, name, meta);
}
