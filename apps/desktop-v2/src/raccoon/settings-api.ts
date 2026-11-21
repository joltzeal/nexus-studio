import { nativeApi } from "./api";

export type WorkbenchSettings = {
  language: "zh" | "en" | "ru";
  startMinimized: boolean;
  closeBehavior: "exit" | "minimize";
  profileDefaults: {
    timezone: string; language: string; webrtc: "auto" | "tcp_only" | "block";
    doNotTrack: boolean; maximized: boolean;
  };
};
export type NetworkSettings = { mode: "direct" | "system" | "manual"; url: string | null };
export type WorkbenchInfo = {
  version: string; platform: string; debug: boolean; dataPath: string;
  databaseBytes: number; profiles: number; folders: number; proxies: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("设置返回格式无效");
  return value as Record<string, unknown>;
}
function settings(value: unknown): WorkbenchSettings {
  const row = record(value);
  const defaults = record(row.profileDefaults);
  if (!["zh", "en", "ru"].includes(String(row.language)) || typeof row.language !== "string"
    || typeof row.startMinimized !== "boolean" || typeof row.closeBehavior !== "string" || !["exit", "minimize"].includes(row.closeBehavior)
    || typeof defaults.timezone !== "string" || typeof defaults.language !== "string"
    || typeof defaults.webrtc !== "string" || !["auto", "tcp_only", "block"].includes(defaults.webrtc)
    || typeof defaults.doNotTrack !== "boolean" || typeof defaults.maximized !== "boolean") throw new Error("设置返回格式无效");
  return row as WorkbenchSettings;
}
function network(value: unknown): NetworkSettings {
  const row = record(value);
  if (typeof row.mode !== "string" || !["direct", "system", "manual"].includes(row.mode) || (row.url !== null && typeof row.url !== "string")) throw new Error("网络设置返回格式无效");
  return row as NetworkSettings;
}
function info(value: unknown): WorkbenchInfo {
  const row = record(value);
  if (typeof row.version !== "string" || typeof row.platform !== "string" || typeof row.dataPath !== "string" || typeof row.debug !== "boolean"
    || [row.databaseBytes, row.profiles, row.folders, row.proxies].some((n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) throw new Error("工作台信息返回格式无效");
  return row as WorkbenchInfo;
}
export const workbenchSettingsApi = {
  get: async () => settings(await nativeApi.call("workbench_settings_get")),
  save: async (value: WorkbenchSettings) => settings(await nativeApi.call("workbench_settings_set", { value })),
  network: async () => network(await nativeApi.call("network_proxy_get")),
  saveNetwork: async (value: NetworkSettings) => network(await nativeApi.call("network_proxy_set", { value })),
  info: async () => info(await nativeApi.call("workbench_info")),
  revealStorage: () => nativeApi.call("workbench_storage_reveal"),
};

/** Read persisted defaults for each new native form, including saves from other windows. */
export async function loadNativeProfileDefaults() {
  return (await workbenchSettingsApi.get()).profileDefaults;
}
