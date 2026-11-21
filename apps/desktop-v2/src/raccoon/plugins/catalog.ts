import { create } from "zustand";
import { pluginApi } from "./api";
import type { PluginView } from "./types";

type Catalog = {
  plugins: PluginView[];
  loaded: boolean;
  error: string | null;
  activeId: string | null;
};

export const usePluginCatalog = create<Catalog>(() => ({
  plugins: [], loaded: false, error: null, activeId: null,
}));

let request: Promise<void> | null = null;

export function refreshPluginCatalog(): Promise<void> {
  if (request) return request;
  request = pluginApi.list().then((plugins) => {
    usePluginCatalog.setState((current) => ({
      plugins, loaded: true, error: null,
      activeId: plugins.some((plugin) => plugin.id === current.activeId && plugin.enabled && plugin.state !== "available")
        ? current.activeId : null,
    }));
  }).catch(() => {
    usePluginCatalog.setState({ error: "插件目录读取失败，可重新读取" });
  }).finally(() => { request = null; });
  return request;
}

export function watchPluginCatalog() {
  void refreshPluginCatalog();
  const refresh = () => { if (!document.hidden) void refreshPluginCatalog(); };
  const timer = window.setInterval(refresh, 5000);
  window.addEventListener("raccoon:plugin-catalog-changed", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    clearInterval(timer);
    window.removeEventListener("raccoon:plugin-catalog-changed", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}
