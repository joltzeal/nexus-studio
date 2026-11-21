import { invoke } from "../../../shared/api/invoke";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { nativeExtensionApi } from "../../../raccoon/shardbrowser-library-api";
import type { ExtensionEntry, ExtensionImport, ExtensionUpdate, LinkResult, UpdateResult } from "./types";

export const extensionList = () => isNativeRaccoon() ? nativeExtensionApi.list() : invoke<ExtensionEntry[]>("extension_list");
/** Takes .crx, .zip or unpacked folders; returns what went in and each file refused.
 *  `separate`: a copy beside one the library holds already. */
export const extensionImport = (paths: string[], separate = false) =>
  isNativeRaccoon() ? nativeExtensionApi.import(paths, separate) : invoke<ExtensionImport>("extension_import", { paths, separate });
/** Web Store link, a bare extension id, or a direct .crx / .zip URL. */
export const extensionImportUrl = (url: string, separate = false) =>
  isNativeRaccoon() ? nativeExtensionApi.importUrl(url, separate) : invoke<ExtensionEntry>("extension_import_url", { url, separate });
export const extensionDelete = (id: string) => isNativeRaccoon() ? nativeExtensionApi.remove(id) : invoke("extension_delete", { id });

// ---- Updates from the Web Store ----

/** What is known now, from disk, with no request. */
export const extensionUpdates = () => isNativeRaccoon() ? nativeExtensionApi.updates() : invoke<ExtensionUpdate[]>("extension_updates");
/** Asks the Web Store now (a check under way is waited for). */
export const extensionUpdatesCheck = () => isNativeRaccoon() ? nativeExtensionApi.checkUpdates() : invoke<ExtensionUpdate[]>("extension_updates_check");
/** `confirmed` lets in what the staged version asked about. */
export const extensionUpdate = (id: string, confirmed = false) =>
  isNativeRaccoon() ? nativeExtensionApi.update(id, confirmed) : invoke<UpdateResult>("extension_update", { id, confirmed });
export const extensionLinkSource = (id: string, link: string, confirmed = false) =>
  isNativeRaccoon() ? nativeExtensionApi.linkSource(id, link, confirmed) : invoke<LinkResult>("extension_link_source", { id, link, confirmed });
export const extensionUpdateCancel = (id: string) => isNativeRaccoon() ? nativeExtensionApi.cancelUpdate(id) : invoke<void>("extension_update_cancel", { id });
export const extensionUpdateSkip = (id: string, version: string) => isNativeRaccoon() ? nativeExtensionApi.skipUpdate(id, version) : invoke<void>("extension_update_skip", { id, version });
