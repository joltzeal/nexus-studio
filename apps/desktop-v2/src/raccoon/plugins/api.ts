import { invoke } from "@tauri-apps/api/core";
import { PluginUiDeclarationSchema } from '@nexus/plugin-sdk/ui';
import type {
  MarketEntry, MarketEntryState, MarketStatus, PluginLicenseState,
  PluginLicenseStatus, PluginPermissions, PluginState, PluginView,
} from "./types";

const PLUGIN_STATES = new Set<PluginState>(["available", "starting", "running", "retrying", "unlicensed"]);
const LICENSE_STATES = new Set<PluginLicenseState>(["inactive", "active", "expired", "invalid", "needsConnection"]);
const MARKET_STATES = new Set<MarketEntryState>(["install", "update", "current", "replace"]);

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function text(row: Record<string, unknown>, key: string, message: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function integer(row: Record<string, unknown>, key: string, message: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(message);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string, message: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new Error(message);
  return value;
}

function strings(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(message);
  return value as string[];
}

function permissions(value: unknown): PluginPermissions {
  const row = object(value, "插件权限返回格式无效");
  const storage = text(row, "storage", "插件权限返回格式无效");
  if (storage !== "private" && storage !== "none") throw new Error("插件权限返回格式无效");
  if (typeof row.wantsBrowserAccess !== "boolean") throw new Error("插件权限返回格式无效");
  return {
    networkDomains: strings(row.networkDomains, "插件权限返回格式无效"),
    wantsBrowserAccess: row.wantsBrowserAccess,
    storage,
    secrets: strings(row.secrets, "插件权限返回格式无效"),
  };
}

function plugin(value: unknown): PluginView {
  const row = object(value, "插件目录返回格式无效");
  const state = text(row, "state", "插件目录返回格式无效") as PluginState;
  if (!PLUGIN_STATES.has(state)
    || typeof row.enabled !== "boolean"
    || typeof row.storageDurable !== "boolean"
    || (row.licenseRequired !== undefined && typeof row.licenseRequired !== "boolean")) {
    throw new Error("插件目录返回格式无效");
  }
  return {
    id: text(row, "id", "插件目录返回格式无效"),
    name: text(row, "name", "插件目录返回格式无效"),
    version: text(row, "version", "插件目录返回格式无效"),
    apiVersion: integer(row, "apiVersion", "插件目录返回格式无效"),
    minCoreVersion: text(row, "minCoreVersion", "插件目录返回格式无效"),
    capabilities: strings(row.capabilities, "插件目录返回格式无效"),
    granted: strings(row.granted, "插件目录返回格式无效"),
    permissions: permissions(row.permissions),
    source: text(row, "source", "插件目录返回格式无效"),
    state,
    enabled: row.enabled,
    methods: strings(row.methods, "插件目录返回格式无效"),
    status: row.status,
    lastError: nullableText(row, "lastError", "插件目录返回格式无效"),
    storageDurable: row.storageDurable,
    secretSlots: strings(row.secretSlots, "插件目录返回格式无效"),
    sourceDirectory: nullableText(row, "sourceDirectory", "插件目录返回格式无效"),
    ui: row.ui == null ? null : PluginUiDeclarationSchema.parse(row.ui),
    installation: row.installation === undefined ? '' : text(row, 'installation', '插件安装标识无效'),
    runtimeGeneration: row.runtimeGeneration == null ? null : text(row, 'runtimeGeneration', '插件进程标识无效'),
    licenseRequired: row.licenseRequired === true,
  };
}

function license(value: unknown): PluginLicenseStatus {
  const row = object(value, "插件授权返回格式无效");
  const state = text(row, "state", "插件授权返回格式无效") as PluginLicenseState;
  if (!LICENSE_STATES.has(state)
    || (row.expiresAt !== null && (typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0))) {
    throw new Error("插件授权返回格式无效");
  }
  return {
    state,
    expiresAt: row.expiresAt as number | null,
    deviceCode: text(row, "deviceCode", "插件授权返回格式无效"),
  };
}

function licenses(value: unknown): Record<string, PluginLicenseStatus> {
  const row = object(value, "插件授权列表返回格式无效");
  return Object.fromEntries(Object.entries(row).map(([id, status]) => [id, license(status)]));
}

function marketEntry(value: unknown): MarketEntry {
  const row = object(value, "插件商店返回格式无效");
  const state = text(row, "state", "插件商店返回格式无效") as MarketEntryState;
  if (!MARKET_STATES.has(state)) throw new Error("插件商店返回格式无效");
  return {
    id: text(row, "id", "插件商店返回格式无效"),
    name: text(row, "name", "插件商店返回格式无效"),
    version: text(row, "version", "插件商店返回格式无效"),
    apiVersion: integer(row, "apiVersion", "插件商店返回格式无效"),
    minCoreVersion: text(row, "minCoreVersion", "插件商店返回格式无效"),
    description: text(row, "description", "插件商店返回格式无效"),
    changelog: text(row, "changelog", "插件商店返回格式无效"),
    capabilities: strings(row.capabilities, "插件商店返回格式无效"),
    installedVersion: nullableText(row, "installedVersion", "插件商店返回格式无效"),
    state,
    size: integer(row, "size", "插件商店返回格式无效"),
    checksum: text(row, "checksum", "插件商店返回格式无效"),
    selection: text(row, "selection", "插件商店返回格式无效"),
    licenseStatus: row.licenseStatus === null ? null : license(row.licenseStatus),
    replacesInstallation: nullableText(row, "replacesInstallation", "插件商店返回格式无效"),
    installedCatalogUrl: nullableText(row, "installedCatalogUrl", "插件商店返回格式无效"),
  };
}

function market(value: unknown): MarketStatus {
  const row = object(value, "插件商店状态返回格式无效");
  if (!Array.isArray(row.entries)) throw new Error("插件商店状态返回格式无效");
  return {
    storeUrl: nullableText(row, "storeUrl", "插件商店状态返回格式无效"),
    catalogUrl: nullableText(row, "catalogUrl", "插件商店状态返回格式无效"),
    lastCheckedAt: nullableText(row, "lastCheckedAt", "插件商店状态返回格式无效"),
    lastError: nullableText(row, "lastError", "插件商店状态返回格式无效"),
    entries: row.entries.map(marketEntry),
  };
}

function errorOf(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error(typeof cause === "string" && cause.length <= 4096 ? cause : "插件操作失败，请重试");
}

async function call<T>(command: string, args: Record<string, unknown> | undefined, parse: (value: unknown) => T): Promise<T> {
  try {
    return parse(await invoke<unknown>(command, args));
  } catch (cause) {
    throw errorOf(cause);
  }
}

export const pluginApi = {
  list: () => call("plugin_catalog", undefined, (value) => {
    if (!Array.isArray(value)) throw new Error("插件目录返回格式无效");
    return value.map(plugin);
  }),
  licenseStatus: () => call("plugin_license_status", undefined, licenses),
  activate: (pluginId: string, card: string, marketSelection?: string, installedSelection?: string) =>
    call("plugin_license_activate", { pluginId, card, marketSelection, installedSelection }, license),
  installLocal: (source: string) => call("plugin_install", { source }, plugin),
  async uninstall(id: string): Promise<void> {
    try {
      await invoke("plugin_uninstall", { id });
    } catch (cause) {
      throw errorOf(cause);
    }
  },
  marketStatus: () => call("plugin_market_status", undefined, market),
  setMarketStore: (url: string | null) => call("plugin_market_set_store", { url }, market),
  refreshMarket: () => call("plugin_market_refresh", undefined, market),
  installMarket: (entry: MarketEntry, replacement?: string) =>
    call("plugin_market_install", { id: entry.id, selection: entry.selection, replacement }, plugin),
};
