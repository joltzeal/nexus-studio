import type { FingerprintEntry, GpuCompat, HostGlCaps } from "../entities/fingerprint/model/types";
import { nativeApi } from "./api";
import { workspace } from "./store";

function fingerprint(value: unknown): FingerprintEntry {
  if (!value || typeof value !== "object") throw new Error("指纹数据格式无效");
  const entry = value as Record<string, unknown>;
  for (const key of ["id", "label", "platform", "chrome", "gpu", "tag_color"]) {
    if (typeof entry[key] !== "string") throw new Error("指纹数据格式无效");
  }
  if (typeof entry.builtin !== "boolean" || !entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) throw new Error("指纹内容格式无效");
  return entry as FingerprintEntry;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export async function nativeGpuCaps(force: boolean): Promise<HostGlCaps> {
  const value = await nativeApi.call("shardbrowser_gpu_caps", { connectionId: shardConnectionId(), force });
  if (!value || typeof value !== "object") throw new Error("GPU 信息格式无效");
  const row = value as Record<string, unknown>;
  if (typeof row.renderer !== "string" || typeof row.vendor !== "string" || typeof row.engine_version !== "string" || !strings(row.webgl1) || !strings(row.webgl2)) throw new Error("GPU 信息格式无效");
  return row as HostGlCaps;
}

export async function nativeGpuCompat(): Promise<Record<string, GpuCompat>> {
  const value = await nativeApi.call("shardbrowser_gpu_compat", { connectionId: shardConnectionId() });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GPU 兼容性信息格式无效");
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== "object" || typeof entry.compatible !== "boolean" || typeof entry.profile_renderer !== "string" || !strings(entry.missing_webgl1) || !strings(entry.missing_webgl2) || !strings(entry.missing_webgpu)) throw new Error("GPU 兼容性信息格式无效");
  }
  return value as Record<string, GpuCompat>;
}

export function shardConnectionId() {
  const { connectionId, connections } = workspace.state;
  if (!connectionId || !connections.some((row) => row.id === connectionId && row.providerId === "shardbrowser" && row.enabled)) {
    throw new Error("请先选择已启用的 ShardBrowser Workspace");
  }
  return connectionId;
}

export const nativeFingerprintApi = {
  async list(): Promise<FingerprintEntry[]> {
    const connectionId = shardConnectionId();
    const value = await nativeApi.call("shardbrowser_fingerprint_list", { connectionId });
    if (workspace.state.connectionId !== connectionId) throw new Error("Workspace 已切换");
    if (!Array.isArray(value)) throw new Error("指纹库格式无效");
    return value.map(fingerprint);
  },
  async import(jsonText: string, idHint: string | null): Promise<FingerprintEntry> {
    return fingerprint(await nativeApi.call("shardbrowser_fingerprint_import", { connectionId: shardConnectionId(), jsonText, idHint }));
  },
  remove: (id: string) => nativeApi.call("shardbrowser_fingerprint_delete", { connectionId: shardConnectionId(), presetId: id }),
  async directory() {
    const value = await nativeApi.call("shardbrowser_fingerprint_dir", { connectionId: shardConnectionId() });
    if (typeof value !== "string") throw new Error("指纹目录格式无效");
    return value;
  },
  async enrich(presetId: string) {
    const value = await nativeApi.call("shardbrowser_fingerprint_enrich_picks", { connectionId: shardConnectionId(), presetId });
    if (!value || typeof value !== "object") throw new Error("硬件信息格式无效");
    const row = value as Record<string, unknown>;
    if (row.hardware_concurrency !== undefined && (typeof row.hardware_concurrency !== "number" || !Number.isInteger(row.hardware_concurrency) || row.hardware_concurrency <= 0)
      || row.device_memory !== undefined && (typeof row.device_memory !== "number" || !Number.isFinite(row.device_memory) || row.device_memory <= 0)
      || row.platform_version !== undefined && typeof row.platform_version !== "string") throw new Error("硬件信息格式无效");
    return { hardware_concurrency: row.hardware_concurrency as number | undefined, device_memory: row.device_memory as number | undefined, platform_version: row.platform_version as string | undefined };
  },
};
