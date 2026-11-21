import { moveNativeProfilesToTrash } from "./trash-adapter";
import { projectNativeFolderMeta } from "./folder-adapter";
import type { BrowserWindow } from "@nexus/contracts/browser";
import { loadNativeProfileForm, saveNativeFormFields } from "./profile-form-adapter";
import { cloneNativeProfile, exportNativeProfiles, importNativeProfiles, pinNativeProfile, regenerateNativeProfiles } from "./profile-actions";
import { useFingerprint } from "../entities/fingerprint/lib/useFingerprint";
import { setNativeTagConnection } from "./tag-api";
import { useProfile } from "../entities/profile/lib/useProfile";
import { useProfileUi } from "../entities/profile/lib/useProfileUi";
import { useViews, reloadViewsForConnection } from "../entities/profile/lib/views";
import type { ProfileMeta } from "../entities/profile/model/types";
import type { ProxyEntry } from "../entities/proxy/model/types";
import { confirmModal } from "../shared/lib/confirm";
import { toast } from "../shared/model/toast";
import { emptyFilters, loadSort } from "../entities/profile/lib/listing";
import { loadProfileLayout } from "../entities/profile/lib/columns";
import { setNativePreferenceConnection } from "./runtime";
import { closeNativeEditor } from "./store";
import type { NativeWorkspace } from "./controller";
import { useProxy } from "../entities/proxy/lib/useProxy";
import { storeBus } from "../shared/lib/storeBus";
import type { AssignPair } from "../entities/profile/lib/assignment";
import { showCloakSessionDiagnostics } from "./cloakbrowser-diagnostics";
import { profileProxyBinding, profileProxyChoice } from "./profile-proxy";

function metaOf(profile: BrowserWindow, folders: Map<string, string>): ProfileMeta {
  const metadata = profile.settings.shardbrowser?._meta;
  const color = metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.color === "string" ? metadata.color : null;
  const extensions = metadata && typeof metadata === "object" && !Array.isArray(metadata) && Array.isArray(metadata.extensions)
    ? metadata.extensions.filter((id): id is string => typeof id === "string")
    : [];
  const navigator = profile.settings.shardbrowser?.navigator;
  const userAgent = navigator && typeof navigator === "object" && !Array.isArray(navigator) && typeof navigator.user_agent === "string" ? navigator.user_agent : "";
  return {
    id: profile.id, name: profile.name, notes: profile.settings.note,
    proxy_id: profileProxyChoice(profile),
    folder: profile.groupId ? folders.get(profile.groupId) ?? "" : "",
    created_at: new Date(profile.createdAt * 1000).toISOString(),
    last_launched_at: profile.lastOpenedAt ? new Date(profile.lastOpenedAt * 1000).toISOString() : null,
    pinned: !!metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.pinned === true,
    total_runtime_ms: profile.activity?.totalRuntimeMs ?? 0, launches: profile.activity?.launches,
    color, extensions, mobile: /Android/i.test(userAgent),
    nativeState: profile.state,
  };
}

function proxyOf(profile: BrowserWindow): ProxyEntry[] {
  if (profile.proxyMode === "direct" || profile.proxyId) return [];
  let address: URL;
  try { address = new URL(profile.proxy ?? "http://unresolved.invalid:1"); }
  catch { address = new URL("http://unresolved.invalid:1"); }
  const choice = profileProxyChoice(profile);
  if (!choice) return [];
  return [{
    id: choice, name: profile.proxyMode === "plugin" ? (profile.proxyEndpoint ? `插件代理 #${profile.proxyEndpoint}` : "插件代理") : address.host,
    kind: address.protocol === "socks5:" ? "socks5" : address.protocol === "https:" ? "https" : "http",
    host: address.hostname, port: Number(address.port || 80), username: "", password: "", country: "", notes: "",
  }];
}

export function connectProfileTable(workspace: NativeWorkspace) {
  const preferences = new Map<string, { views: ReturnType<typeof useViews.getState>["views"]; columns: ReturnType<typeof useProfileUi.getState>["columns"]; widths: ReturnType<typeof useProfileUi.getState>["widths"]; sort: ReturnType<typeof useProfileUi.getState>["sort"] }>();
  let connectionId: string | null = null;
  function project() {
    const state = workspace.state;
    if (state.connectionId !== connectionId) {
      if (connectionId) {
        const ui = useProfileUi.getState();
        preferences.set(connectionId, { views: useViews.getState().views, columns: ui.columns, widths: ui.widths, sort: ui.sort });
      }
      connectionId = state.connectionId;
      setNativePreferenceConnection(connectionId);
      closeNativeEditor();
      const saved = connectionId ? preferences.get(connectionId) : undefined;
      if (saved) useViews.setState({ views: saved.views });
      else reloadViewsForConnection();
      useProfileUi.setState({
        folder: "all", search: "", filters: emptyFilters(), selected: new Set(),
        anchorId: null, activeId: null, peekId: null, editing: null, folderDialog: null,
        folderPicker: null, tagPicker: null, assign: null, viewDialog: null, viewId: null, viewEdit: null, base: null, only: null,
        ...(saved ? { columns: saved.columns, widths: saved.widths, sort: saved.sort } : { ...loadProfileLayout(), sort: loadSort() }),
      });
      setNativeTagConnection(connectionId);
      useFingerprint.setState({ items: [], status: "idle", error: null, peekId: null, importerOpen: false });
    }
    projectNativeFolderMeta(state.folders);
    const folders = new Map(state.folders.map((row) => [row.id, row.name]));
    const running: Record<string, number> = {};
    const pending: Record<string, { kind: "start" | "stop"; at: number }> = {};
    for (const row of state.profiles) {
      if (row.state === "running") running[row.id] = (row.lastOpenedAt ?? row.createdAt) * 1000;
      if (row.state === "starting" || row.state === "stopping") pending[row.id] = { kind: row.state === "starting" ? "start" : "stop", at: Date.now() };
    }
    useProfile.setState({
      profiles: state.profiles.map((row) => metaOf(row, folders)),
      proxies: [...new Map([...useProxy.getState().proxies, ...state.profiles.flatMap(proxyOf)].map((proxy) => [proxy.id, proxy])).values()],
      fingerprints: useFingerprint.getState().items, running, pending,
      startBusy: new Set(state.profiles.filter((row) => row.state === "starting").map((row) => row.id)),
      folderRegistry: state.folders.map((row) => row.name),
      status: state.loading ? "loading" : state.error && state.profiles.length === 0 ? "error" : "ready",
      error: state.error,
    });
  }
  const row = (id: string) => {
    const profile = workspace.state.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("Profile 不存在");
    return profile;
  };
  function reportActionError(profile: BrowserWindow | undefined, error: unknown) {
    const limited = profile?.providerId === "cloakbrowser" && error instanceof Error &&
      "code" in error && error.code === "rate_limited";
    toast.fail({ title: "Profile 操作失败", detail: error, action: limited ? {
      label: "检查授权席位", run: () => { void showCloakSessionDiagnostics(); },
    } : undefined });
  }
  const groupId = (name: string) => {
    if (!name) return null;
    const folder = workspace.state.folders.find((item) => item.name === name);
    if (!folder) throw new Error("Folder 不存在");
    return folder.id;
  };
  const edit = async (id: string, fields: Partial<Pick<BrowserWindow, "name" | "settings">>) => {
    try {
      const profile = row(id);
      await workspace.update({ id, name: fields.name ?? profile.name, settings: fields.settings ?? profile.settings, proxyId: profile.proxyId ?? null, proxy: profile.proxy, proxyMode: profile.proxyMode, proxyPlugin: profile.proxyPlugin, proxyEndpoint: profile.proxyEndpoint, groupId: profile.groupId });
      return true;
    } catch (error) { toast.fail({ title: "Profile 保存失败", detail: error }); return false; }
  };
  async function run(ids: string[], action: "start" | "stop") {
    const failed: string[] = [];
    for (const id of ids) {
      try { await workspace[action](id); }
      catch (error) {
        failed.push(id);
        if (action === "start") useProfile.setState((state) => ({ startFailed: { ...state.startFailed, [id]: Date.now() }, failReasons: { ...state.failReasons, [id]: String(error) } }));
        reportActionError(workspace.state.profiles.find((profile) => profile.id === id), error);
      }
    }
    return failed;
  }
  async function bindProxy(id: string, proxyId: string | null) {
    try {
      const profile = row(id);
      await workspace.update({ id, name: profile.name, settings: profile.settings, groupId: profile.groupId,
        ...profileProxyBinding(proxyId, profile) });
      return true;
    } catch (error) { toast.fail({ title: "代理分配失败", detail: error }); return false; }
  }
  async function assignPairs(pairs: AssignPair[]) {
    let success = true;
    for (const pair of pairs) if (!await bindProxy(pair.profileId, pair.proxyId)) success = false;
    return success;
  }
  useProfile.setState({
    init: () => workspace.refresh(), reload: () => workspace.refresh(),
    startProcessPolling: () => () => {},
    loadForm: loadNativeProfileForm,
    saveProfile: async (form, opts) => {
      try { await saveNativeFormFields(form); return "ok"; }
      catch (error) { opts?.onFailed?.(error); toast.fail({ title: "Profile 保存失败", detail: error }); return "failed"; }
    },
    cloneProfile: async (id) => {
      try { await cloneNativeProfile(id); }
      catch (error) { toast.fail({ title: "克隆失败", detail: error }); }
    },
    togglePin: async (profile) => {
      try { await pinNativeProfile(profile); }
      catch (error) { toast.fail({ title: "置顶保存失败", detail: error }); }
    },
    exportMany: async (ids) => {
      try { await exportNativeProfiles(ids); }
      catch (error) { toast.fail({ title: "配置导出失败", detail: error }); }
    },
    importFromClipboard: async () => {
      try { await importNativeProfiles(); }
      catch (error) { toast.fail({ title: "配置导入失败", detail: error }); }
    },
    regenerateFingerprints: regenerateNativeProfiles,
    prefetchForms: () => {},
    startStop: async (profile) => {
      const current = row(profile.id);
      const starting = current.state !== "running";
      try {
        await workspace[starting ? "start" : "stop"](profile.id);
        const { startFailed, failReasons } = useProfile.getState();
        useProfile.setState({ startFailed: Object.fromEntries(Object.entries(startFailed).filter(([id]) => id !== profile.id)), failReasons: Object.fromEntries(Object.entries(failReasons).filter(([id]) => id !== profile.id)) });
        return null;
      }
      catch (error) {
        if (starting) useProfile.setState((state) => ({ startFailed: { ...state.startFailed, [profile.id]: Date.now() }, failReasons: { ...state.failReasons, [profile.id]: String(error) } }));
        reportActionError(current, error); return String(error);
      }
    },
    launchMany: (ids) => run(ids, "start"), stopMany: (ids) => run(ids, "stop"),
    bindProxy,
    assignPairs,
    assignProxies: (ids, proxies) => assignPairs(ids.map((profileId, index) => ({ profileId, proxyId: proxies[index % Math.max(1, proxies.length)] ?? null }))),
    renameProfile: (id, name) => edit(id, { name }),
    setNotes: async (id, note) => {
      const profile = workspace.state.profiles.find((item) => item.id === id);
      return profile ? edit(id, { settings: { ...profile.settings, note } }) : false;
    },
    moveMany: async (ids, name) => {
      try { await workspace.move(ids, groupId(name)); return true; }
      catch (error) { toast.fail({ title: "移动 Folder 失败", detail: error }); return false; }
    },
    setProfileFolder: async (id, name) => {
      try { await workspace.move([id], groupId(name)); }
      catch (error) { toast.fail({ title: "移动 Folder 失败", detail: error }); }
    },
    deleteMany: moveNativeProfilesToTrash,
    deleteFolder: async (name) => {
      if (!await confirmModal({ title: "删除 Folder", message: "Folder 中的 Profile 将移至全部配置。", confirmLabel: "删除 Folder", danger: true })) return;
      try {
        const id = groupId(name);
        if (id) await workspace.deleteFolder(id);
        useViews.getState().renameFolder(name, "all");
        const ui = useProfileUi.getState();
        if (ui.folder === name) ui.setFolder("all");
        if (ui.base?.folder === name) useProfileUi.setState({ base: { ...ui.base, folder: "all" } });
      }
      catch (error) { toast.fail({ title: "删除 Folder 失败", detail: error }); }
    },
    renameFolder: async (from, name) => {
      try {
        await workspace.saveFolder(name, groupId(from) ?? undefined);
        useViews.getState().renameFolder(from, name);
        useProfileUi.getState().followFolderRename(from, name);
        return true;
      }
      catch (error) { toast.fail({ title: "Folder 保存失败", detail: error }); return false; }
    },
  });
  project();
  const unsubscribe = workspace.subscribe(project);
  const unsubscribeProxies = useProxy.subscribe((state, previous) => {
    if (state.proxies !== previous.proxies) project();
  });
  const unsubscribeFingerprints = useFingerprint.subscribe((state, previous) => {
    if (state.items !== previous.items) useProfile.setState({ fingerprints: state.items });
  });
  const unsubscribeBus = storeBus.on("proxies", () => { void useProxy.getState().reload(); });
  return () => { unsubscribe(); unsubscribeProxies(); unsubscribeFingerprints(); unsubscribeBus(); };
}
