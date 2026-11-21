import { nativeApi } from "./api";
import { shardConnectionId } from "./fingerprint-api";
import { workspace } from "./store";

function context(profileId: string) {
  const connectionId = shardConnectionId();
  const profile = workspace.state.profiles.find((row) => row.id === profileId);
  if (!profile || profile.connectionId !== connectionId || profile.providerId !== "shardbrowser") {
    throw new Error("Profile 不属于当前 ShardBrowser Workspace");
  }
  return connectionId;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Cookie 操作返回格式无效");
  }
  return value;
}

export async function nativeCookiesImport(profileId: string, cookies: unknown[]): Promise<number> {
  const connectionId = context(profileId);
  return count(await nativeApi.call("shardbrowser_cookies_import", { connectionId, profileId, cookies }));
}

export async function nativeCookiesExportToFile(profileId: string, path: string): Promise<number> {
  const connectionId = context(profileId);
  return count(await nativeApi.call("shardbrowser_cookies_export_to_file", { connectionId, profileId, path }));
}

export async function nativeProfileCdp(profileId: string) {
  const value = await nativeApi.call("shardbrowser_profile_cdp", { connectionId: context(profileId), profileId });
  if (!value || typeof value !== "object") throw new Error("调试地址格式无效");
  const row = value as Record<string, unknown>;
  if (typeof row.port !== "number" || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535
    || typeof row.http_url !== "string" || row.http_url !== `http://127.0.0.1:${row.port}`
    || typeof row.web_socket_debugger_url !== "string") throw new Error("调试地址格式无效");
  const socket = new URL(row.web_socket_debugger_url);
  if (socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || Number(socket.port) !== row.port
    || socket.username || socket.password || socket.search || socket.hash || !/^\/devtools\/browser\/[\w-]+$/.test(socket.pathname)) throw new Error("调试地址格式无效");
  return { port: row.port, http_url: row.http_url, web_socket_debugger_url: row.web_socket_debugger_url };
}

export async function nativeProfileFocus(profileId: string): Promise<void> {
  await nativeApi.call("shardbrowser_profile_focus", { connectionId: context(profileId), profileId });
}

export async function nativeProfileSetPin(id: string, pinned: boolean): Promise<boolean> {
  const value = await nativeApi.call("browser_window_set_pin", { connectionId: context(id), id, pinned });
  if (typeof value !== "boolean" || value !== pinned) throw new Error("Profile 置顶返回格式无效");
  return value;
}
