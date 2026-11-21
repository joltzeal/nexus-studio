import type { BrowserConnection } from "@nexus/contracts/browser";
import { parseCloakLocalSessions, parseCloakSeats } from "./cloakbrowser-contract";
import {
  isKernelVersion,
  nativeApi,
  type CloakKernelRelease,
  type CloakKernelStatus,
  type CloakLicenseStatus,
} from "./api";

export type { CloakKernelRelease, CloakKernelStatus, CloakLicenseStatus };

export function cloakLicenseApi() {
  return {
    get: () => nativeApi.call("license_status") as Promise<CloakLicenseStatus>,
    save: (key: string) => nativeApi.call("license_set", { key }) as Promise<CloakLicenseStatus>,
    remove: () => nativeApi.call("license_remove") as Promise<void>,
    seats: async () => parseCloakSeats(await nativeApi.call("license_seats")),
    localSessions: async () => parseCloakLocalSessions(await nativeApi.call("browser_cloakbrowser_sessions")),
  };
}

export function cloakKernelApi() {
  return {
    status: (refresh = false) => nativeApi.call("kernel_status", { refresh }) as Promise<CloakKernelStatus>,
    checkLatest: () => nativeApi.call("kernel_check_latest") as Promise<CloakKernelRelease>,
    download: (version?: string | null) => {
      if (version != null && !isKernelVersion(version)) throw new Error("请输入由 4–5 段数字组成的完整包版本，最多 48 个字符。");
      return (version == null ? nativeApi.call("kernel_download") : nativeApi.call("kernel_download", { version })) as Promise<string>;
    },
    remove: (version: string) => {
      if (!isKernelVersion(version)) throw new Error("内核版本无效");
      return nativeApi.call("kernel_delete", { version }) as Promise<void>;
    },
  };
}

export function setCloakBrowserEnabled(enabled: boolean): Promise<BrowserConnection> {
  return nativeApi.call("browser_managed_cloakbrowser_set", { enabled }) as Promise<BrowserConnection>;
}
