import type { PluginUiDeclaration } from '@nexus/plugin-sdk/ui';

export type PluginState = "available" | "starting" | "running" | "retrying" | "unlicensed";
export type PluginLicenseState = "inactive" | "active" | "expired" | "invalid" | "needsConnection";
export type MarketEntryState = "install" | "update" | "current" | "replace";

export type PluginPermissions = {
  networkDomains: string[];
  wantsBrowserAccess: boolean;
  storage: "private" | "none";
  secrets: string[];
};

export type PluginView = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  minCoreVersion: string;
  capabilities: string[];
  granted: string[];
  permissions: PluginPermissions;
  source: string;
  state: PluginState;
  enabled: boolean;
  methods: string[];
  status: unknown;
  lastError: string | null;
  storageDurable: boolean;
  secretSlots: string[];
  sourceDirectory: string | null;
  ui?: PluginUiDeclaration | null;
  installation?: string;
  runtimeGeneration?: string | null;
  licenseRequired?: boolean;
};

export type PluginLicenseStatus = {
  state: PluginLicenseState;
  expiresAt: number | null;
  deviceCode: string;
};

export type MarketEntry = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  minCoreVersion: string;
  description: string;
  changelog: string;
  capabilities: string[];
  installedVersion: string | null;
  state: MarketEntryState;
  size: number;
  checksum: string;
  selection: string;
  licenseStatus: PluginLicenseStatus | null;
  replacesInstallation: string | null;
  installedCatalogUrl: string | null;
};

export type MarketStatus = {
  storeUrl: string | null;
  catalogUrl: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  entries: MarketEntry[];
};
