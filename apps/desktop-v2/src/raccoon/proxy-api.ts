import { BrowserProxyEntrySchema, BrowserProxyTestSnapshotSchema } from "@nexus/contracts/browser";
import { nativeApi } from "./api";

export async function callProxy<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const value = await nativeApi.call(command, args);
  let result: unknown;
  switch (command) {
    case "browser_proxy_list": case "browser_proxy_bulk_parse":
      if (!Array.isArray(value)) throw new Error("代理列表返回格式无效");
      result = BrowserProxyEntrySchema.array().parse(value); break;
    case "browser_proxy_save": result = BrowserProxyEntrySchema.parse(value); break;
    case "browser_proxy_full_test": result = BrowserProxyTestSnapshotSchema.parse(value); break;
    case "browser_proxy_last_test": result = value === null ? null : BrowserProxyTestSnapshotSchema.parse(value); break;
    case "browser_proxy_history":
      if (!Array.isArray(value)) throw new Error("代理历史返回格式无效");
      result = BrowserProxyTestSnapshotSchema.array().parse(value); break;
    case "browser_proxy_bulk_save": case "browser_proxy_bulk_import":
      if (!Number.isInteger(value) || Number(value) < 0) throw new Error("代理保存结果无效");
      result = value; break;
    default: result = value;
  }
  return result as T;
}
