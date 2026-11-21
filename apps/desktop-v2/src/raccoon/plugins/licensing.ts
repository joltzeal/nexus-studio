export const FIRST_PARTY_PLUGIN_IDS = new Set([
  "studio.address-generator",
  "studio.ai-image",
  "studio.email",
  "studio.products",
  "studio.proxy-pool",
  "studio.sales-agent",
  "studio.shared-supply",
  "studio.sim8",
  "studio.vinted-accounts",
  "studio.vinted-monitor",
  "studio.window-sync",
]);

export function requiresPluginLicense(pluginId: string): boolean {
  return FIRST_PARTY_PLUGIN_IDS.has(pluginId);
}

export function hasUsablePluginLicense(state: string | undefined): boolean {
  return state === "active";
}
