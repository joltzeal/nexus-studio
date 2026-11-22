import type { ProxyRow, Subscription } from "../../raccoon/plugins/proxy-pool/model";
import { EMPTY_QUERY, PROXY_PLUGIN_ID } from "../../raccoon/plugins/proxy-pool/model";
import type { Handler } from "./handlers";

const methods = [
  "proxy.list", "proxy.create", "proxy.update", "proxy.delete", "proxy.check", "proxy.import",
  "proxy.groups.list", "proxy.groups.create", "proxy.config.get", "proxy.config.set", "proxy.exportUrls",
  "proxy.subscriptions.list", "proxy.subscriptions.create", "proxy.subscriptions.delete",
  "proxy.subscriptions.preview", "proxy.subscriptions.export", "proxy.subscriptions.append",
];
const rows: ProxyRow[] = [
  { name: "US · Listing 01", host: "us.proxy.example.com", port: 10001, username: "studio-session-listing-01" },
  { name: "DE · Research", host: "de.proxy.example.com", port: 10002, username: "studio-session-research" },
  { name: "UK · Account 02", host: "uk.proxy.example.com", port: 10003, username: "studio-session-account-02" },
  { name: "FR · Archive", host: "fr.proxy.example.com", port: 10004, username: "" },
  { name: "US · Listing 03", host: "us.proxy.example.com", port: 10005, username: "studio-session-listing-03" },
].map((row, index) => ({
  ...row, id: String(index + 1), groupId: index === 3 ? null : "1", schemes: index === 1 ? ["socks5", "socks5h"] : ["http"],
  enabled: index !== 3, udp: true, hasPassword: index !== 3,
  checkStatus: index === 2 ? "failed" : index === 3 ? "unknown" : "ok", checkedScheme: index === 1 ? "socks5" : "http",
  checkedAt: index === 3 ? null : "2026-11-18T10:30:00Z", exitIp: index === 3 ? null : `203.0.113.${14 + index}`,
  previousExitIp: null, previousExitIpCheckedAt: null, exitIpChanged: false,
  geo: { status: "ok", country: ["美国", "德国", "英国", "法国", "美国"][index], countryCode: null, region: null, city: null, isp: null, error: null },
  reputation: index === 3 ? null : { status: "ok", risk: [4, 12, 78, 0, 8][index], proxy: true, vpn: false, hosting: false, networkType: "Residential", provider: null, asn: null, error: null },
  latencyMs: index === 3 ? null : [184, 236, 8000, 0, 192][index], checkError: index === 2 ? "示例检测记录 · 连接超时" : null,
}));
const groups = [{ id: 1, name: "Vinted", createdAt: "2026-11-18T10:00:00Z" }];
const config = { defaultEndpointId: "1" as string | null, risk: { enabled: true, cacheSeconds: 3600, hasApiKey: false } };
const subscriptions: Subscription[] = [];
let nextId = 10;

const plugin = () => ({
  id: PROXY_PLUGIN_ID, name: "代理池", version: "1.0.5", apiVersion: 1, minCoreVersion: "0.1.35",
  capabilities: ["proxy.provider"], granted: ["proxy.provider"],
  permissions: { networkDomains: ["api64.ipify.org", "proxycheck.io"], wantsBrowserAccess: false, storage: "private", secrets: [] },
  source: "preview", state: "running", enabled: true, methods, status: { preview: true },
  lastError: null, storageDurable: false, secretSlots: [], sourceDirectory: null,
  licenseRequired: true,
});
const market = () => ({ storeUrl: null, catalogUrl: null, lastCheckedAt: null, lastError: null, entries: [] });

function previewCall(input: Record<string, unknown>) {
  if (input.id !== PROXY_PLUGIN_ID || input.capability !== "proxy.provider") throw new Error("示例插件不存在");
  const payload = input.payload as Record<string, unknown>;
  switch (input.method) {
    case "proxy.list": {
      const query = { ...EMPTY_QUERY, ...payload };
      const filtered = rows.filter((row) => {
        const risk = row.reputation?.risk;
        return (!query.keyword || `${row.name} ${row.host}`.toLowerCase().includes(query.keyword.toLowerCase()))
          && (query.scheme === null || row.schemes.includes(query.scheme))
          && (query.enabled === null || row.enabled === query.enabled)
          && (query.ungrouped ? row.groupId === null : query.groupId === null || row.groupId === String(query.groupId))
          && (query.isProxy === null || row.reputation?.proxy === query.isProxy)
          && (query.isVpn === null || row.reputation?.vpn === query.isVpn)
          && (query.isHosting === null || row.reputation?.hosting === query.isHosting)
          && (query.riskMin === null || risk !== null && risk !== undefined && risk >= query.riskMin)
          && (query.riskMax === null || risk !== null && risk !== undefined && risk <= query.riskMax);
      });
      return { total: filtered.length, limit: query.limit, offset: query.offset, items: filtered.slice(query.offset, query.offset + query.limit) };
    }
    case "proxy.groups.list": return { items: groups };
    case "proxy.groups.create": {
      const group = { id: nextId++, name: String(payload.name), createdAt: new Date().toISOString() };
      groups.push(group);
      return group;
    }
    case "proxy.config.get": return config;
    case "proxy.config.set": {
      config.defaultEndpointId = payload.defaultEndpointId === null ? null : String(payload.defaultEndpointId);
      config.risk.enabled = Boolean(payload.riskEnabled);
      config.risk.cacheSeconds = Number(payload.riskCacheSeconds);
      if (payload.riskApiKey !== undefined) config.risk.hasApiKey = Boolean(payload.riskApiKey);
      return config;
    }
    case "proxy.create":
    case "proxy.update": {
      const existing = rows.find((row) => row.id === String(payload.id));
      if (input.method === "proxy.update" && !existing) throw new Error("示例端点不存在");
      const row: ProxyRow = {
        id: existing?.id ?? String(nextId++), name: String(payload.name), host: String(payload.host), port: Number(payload.port),
        username: String(payload.username), groupId: payload.groupId === null ? null : String(payload.groupId),
        schemes: payload.schemes as ProxyRow["schemes"], enabled: Boolean(payload.enabled), udp: Boolean(payload.udp),
        hasPassword: payload.password === undefined ? existing?.hasPassword ?? false : Boolean(payload.password),
        checkStatus: "unknown", checkedScheme: null, checkedAt: null, exitIp: null, previousExitIp: null,
        previousExitIpCheckedAt: null, exitIpChanged: false, geo: null, reputation: null, latencyMs: null, checkError: null,
      };
      if (existing) rows.splice(rows.indexOf(existing), 1, row); else rows.unshift(row);
      return row;
    }
    case "proxy.delete": {
      const ids = payload.ids as number[];
      const deleted = rows.filter((row) => ids.includes(Number(row.id))).length;
      for (let index = rows.length - 1; index >= 0; index--) if (ids.includes(Number(rows[index].id))) rows.splice(index, 1);
      return { deleted };
    }
    case "proxy.exportUrls": {
      const ids = payload.ids as number[];
      const selected = rows.filter((row) => ids.includes(Number(row.id)));
      return { urls: selected.map((row) => `${payload.preferredScheme ?? row.schemes[0]}://${row.username ? `${encodeURIComponent(row.username)}:***@` : ""}${row.host}:${row.port}`), count: selected.length, requiresSecret: selected.some((row) => row.hasPassword) };
    }
    case "proxy.subscriptions.list": return { items: subscriptions };
    case "proxy.subscriptions.create": {
      const row: Subscription = {
        id: String(nextId++), name: String(payload.name), enabled: true, sourceMode: payload.sourceMode === "groups" ? "groups" : "selected",
        groupName: String(payload.groupName), includeDirect: Boolean(payload.includeDirect),
        preferredScheme: payload.preferredScheme as Subscription["preferredScheme"],
        memberCount: ((payload.sourceMode === "groups" ? payload.groupIds : payload.proxyIds) as number[]).length,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      subscriptions.push(row);
      return row;
    }
    case "proxy.subscriptions.delete": {
      const index = subscriptions.findIndex((row) => row.id === String(payload.id));
      if (index < 0) throw new Error("示例订阅不存在");
      subscriptions.splice(index, 1);
      return { deleted: 1 };
    }
    case "proxy.subscriptions.preview": return { yaml: "# 网页预览示例\nproxies: []\n", nodeCount: 0, excludedCount: 0, redacted: true };
    default: throw { code: "UNAVAILABLE", message: "此操作需要原生插件进程，网页预览仅用于界面演示", retryable: false };
  }
}

export const proxyPoolPreviewHandlers: Record<string, Handler> = {
  plugin_catalog: () => [plugin()],
  plugin_license_status: () => ({ [PROXY_PLUGIN_ID]: { state: "active", expiresAt: null, deviceCode: "PREVIEW" } }),
  plugin_market_status: market,
  plugin_call: ({ input }) => previewCall(input as Record<string, unknown>),
};
