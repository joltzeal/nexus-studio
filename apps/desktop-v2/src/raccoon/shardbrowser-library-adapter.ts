import { useBookmarks, BOOKMARK_TAB_ALL } from "../entities/bookmark";
import { useExtensions, useExtensionUpdates } from "../entities/extension";
import { useImportBookmarks } from "../features/import-bookmarks";
import type { NativeWorkspace } from "./controller";

function resetLibraries() {
  useBookmarks.setState({
    status: "idle",
    error: null,
    items: [],
    editing: null,
    search: "",
    folder: BOOKMARK_TAB_ALL,
    selected: new Set<string>(),
  });
  useExtensions.setState({
    status: "idle",
    error: null,
    items: [],
    busy: false,
    search: "",
    linkOpen: false,
  });
  useExtensionUpdates.setState({
    byId: {},
    checking: false,
    updatingAll: false,
    working: {},
    linking: {},
    ask: null,
    linkFor: null,
  });
  useImportBookmarks.setState({
    open: false,
    fileName: "",
    file: null,
    problem: null,
    folder: "",
    progress: null,
    stopping: false,
    failure: null,
    stopped: null,
  });
}

export function connectShardBrowserLibraries(owner: NativeWorkspace): () => void {
  let connectionId = owner.state.connectionId;
  return owner.subscribe(() => {
    if (owner.state.connectionId === connectionId) return;
    connectionId = owner.state.connectionId;
    resetLibraries();
  });
}
