import { invoke } from "../../../shared/api/invoke";
import type { ProxyEntry, ProxyTestSnapshot } from "./types";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { callProxy } from "../../../raccoon/proxy-api";

function proxyCall<T>(upstream: string, native: string, args?: Record<string, unknown>): Promise<T> {
  return isNativeRaccoon() ? callProxy<T>(native, args) : invoke<T>(upstream, args);
}

export const proxyList = () => proxyCall<ProxyEntry[]>("proxy_list", "browser_proxy_list");
export const proxySave = (entry: ProxyEntry) => proxyCall<ProxyEntry>("proxy_save", "browser_proxy_save", { entry });

/** A blank entry for the "new proxy" dialog. */
export const emptyProxy = (): ProxyEntry => ({
  id: "",
  name: "",
  kind: "socks5",
  host: "",
  port: 1080,
  username: "",
  password: "",
  country: "",
  notes: "",
});
export const proxyDelete = (id: string) => proxyCall("proxy_delete", "browser_proxy_delete", { id });
export const proxyFullTest = (entry: ProxyEntry) => proxyCall<ProxyTestSnapshot>("proxy_full_test", "browser_proxy_full_test", { entry });
export const proxyLastTest = (id: string) => proxyCall<ProxyTestSnapshot | null>("proxy_last_test", "browser_proxy_last_test", { id });
export const proxyHistory = (id: string) => proxyCall<ProxyTestSnapshot[]>("proxy_history", "browser_proxy_history", { id });
export const proxyBulkParse = (text: string, kind: ProxyEntry["kind"]) => proxyCall<ProxyEntry[]>("proxy_bulk_parse", "browser_proxy_bulk_parse", { text, kind });
export const proxyBulkSave = (entries: ProxyEntry[]) => proxyCall<number>("proxy_bulk_save", "browser_proxy_bulk_save", { entries });
export const proxyBulkImport = (text: string, kind: string) => proxyCall<number>("proxy_bulk_import", "browser_proxy_bulk_import", { text, kind });
