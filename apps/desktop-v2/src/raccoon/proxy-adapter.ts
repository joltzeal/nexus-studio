import { BrowserProxyUsageSchema } from "@nexus/contracts/browser";
import { useProxy } from "../entities/proxy/lib/useProxy";
import { proxyDelete, proxySave } from "../entities/proxy/model/api";
import { storeBus } from "../shared/lib/storeBus";
import { confirmModal } from "../shared/lib/confirm";
import { toast } from "../shared/model/toast";
import type { ProfileMeta } from "../entities/profile/model/types";
import { nativeApi } from "./api";
import { workspace } from "./store";

export type ProxyUsage = { id: string; name: string; connectionId: string; proxyId: string | null };
let usage: ProxyUsage[] = [];
let usageRead = 0;

export function proxyUsage() { return usage; }

export async function refreshProxyUsage() {
  const read = ++usageRead;
  const value = await nativeApi.call("browser_proxy_usage");
  const parsed = BrowserProxyUsageSchema.array().parse(value);
  if (read !== usageRead) return;
  usage = parsed;
  useProxy.setState({ profiles: usage.map((item): ProfileMeta => ({
    id: item.id, name: item.name, proxy_id: item.proxyId, notes: "", folder: "",
    last_launched_at: null, created_at: null, pinned: false, total_runtime_ms: 0,
    color: null, extensions: [], mobile: false,
  })) });
}

export function connectGlobalProxyLibrary() {
  const originalReload = useProxy.getState().reloadProxies;
  useProxy.setState({
    reload: async () => { await originalReload(); await refreshProxyUsage(); },
    saveProxy: async (entry) => {
      try {
        const saved = await proxySave(entry);
        const current = useProxy.getState();
        const previous = current.proxies.find((item) => item.id === saved.id);
        const changed = previous && ["kind", "host", "port", "username", "password"].some((key) => previous[key as keyof typeof previous] !== saved[key as keyof typeof saved]);
        const snapshots = { ...current.snapshots };
        if (changed) delete snapshots[saved.id];
        useProxy.setState({ proxies: previous ? current.proxies.map((item) => item.id === saved.id ? saved : item) : [...current.proxies, saved], snapshots });
        storeBus.emit("proxies", "proxies");
        return true;
      } catch (error) { toast.fail({ title: "代理保存失败", detail: error }); return false; }
    },
    removeProxy: async (id) => { await remove([id]); },
    bulkDelete: async (given) => { await remove(given ?? [...useProxy.getState().proxySel]); },
  });
  async function remove(ids: string[]) {
    if (ids.length === 0) return;
    if (!await confirmModal({ title: "删除代理", message: "正在被 Profile 使用的代理会保留，并显示对应原因。", confirmLabel: "删除代理", danger: true })) return;
    for (const id of ids) {
      try { await proxyDelete(id); }
      catch (error) { toast.fail({ title: "删除代理失败", detail: error }); }
    }
    await useProxy.getState().reload();
    storeBus.emit("proxies", "proxies");
  }
  storeBus.on("proxies", () => { void refreshProxyUsage().catch((error) => toast.fail({ title: "代理关联读取失败", detail: error })); });
  workspace.subscribe(() => {
    if (!workspace.state.loading) void refreshProxyUsage().catch(() => {});
  });
  void useProxy.getState().init().catch((error) => toast.fail({ title: "代理库加载失败", detail: error }));
  void refreshProxyUsage().catch((error) => toast.fail({ title: "代理关联读取失败", detail: error }));
}
