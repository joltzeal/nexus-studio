export type CloakKernelPhase = "idle" | "preparing" | "downloading" | "verifying" | "extracting" | "retrying" | "ready" | "failed";
export type CloakKernelFailure = { code: string; message: string; retryable: boolean };
export type CloakKernelStatus = {
  cacheDir: string;
  platform: string;
  installed: { version: string; binaryPath: string }[];
  activationConfigured: boolean;
  download: {
    phase: CloakKernelPhase;
    percent: number | null;
    downloadedMb: number | null;
    totalMb: number | null;
    attempt: number | null;
    version: string | null;
    requestedVersion: string | null;
    error: CloakKernelFailure | null;
  };
};
export type CloakKernelRelease = { version: string; platform: string; checkedAt: string };
export type CloakLicenseStatus = { configured: boolean; key: string | null; plan: string | null; expires: string | null };
export type CloakLicenseSeats = { active: number | null; limit: number | null };
export type CloakLocalSession = {
  id: string;
  name: string;
  state: "starting" | "running" | "stopping" | "unknown";
  residual: boolean;
};

export function isKernelVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 48 && value.trim() === value && /^[0-9]+(?:\.[0-9]+){3,4}$/.test(value);
}

function failure(value: unknown): CloakKernelFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.code === "string" && row.code && typeof row.message === "string" && row.message && typeof row.retryable === "boolean"
    ? { code: row.code, message: row.message, retryable: row.retryable }
    : null;
}

export function parseCloakKernelStatus(value: unknown): CloakKernelStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("内核状态返回格式无效");
  const status = value as Record<string, unknown>;
  if (typeof status.cacheDir !== "string" || !status.cacheDir || typeof status.platform !== "string" || !status.platform
    || typeof status.activationConfigured !== "boolean" || !Array.isArray(status.installed)
    || status.installed.some((item: unknown) => !item || typeof item !== "object" || !isKernelVersion((item as Record<string, unknown>).version)
      || typeof (item as Record<string, unknown>).binaryPath !== "string" || !(item as Record<string, unknown>).binaryPath)
    || !status.download || typeof status.download !== "object" || Array.isArray(status.download)) throw new Error("内核状态返回格式无效");
  const job = status.download as Record<string, unknown>;
  const phases: CloakKernelPhase[] = ["idle", "preparing", "downloading", "verifying", "extracting", "retrying", "ready", "failed"];
  const measurement = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (typeof job.phase !== "string" || !phases.includes(job.phase as CloakKernelPhase)
    || !measurement(job.percent) || (job.percent !== null && (job.percent as number) > 100)
    || !measurement(job.downloadedMb) || !measurement(job.totalMb)
    || !(job.attempt === null || (typeof job.attempt === "number" && Number.isInteger(job.attempt) && job.attempt >= 1 && job.attempt <= 3))
    || !(job.version === null || typeof job.version === "string")
    || !(job.requestedVersion == null || isKernelVersion(job.requestedVersion))
    || !(job.error === null || failure(job.error))) throw new Error("内核下载进度返回格式无效");
  return {
    cacheDir: status.cacheDir, platform: status.platform,
    installed: status.installed as CloakKernelStatus["installed"], activationConfigured: status.activationConfigured,
    download: {
      phase: job.phase as CloakKernelPhase,
      percent: job.percent as number | null, downloadedMb: job.downloadedMb as number | null, totalMb: job.totalMb as number | null,
      attempt: job.attempt as number | null, version: job.version as string | null,
      requestedVersion: job.requestedVersion == null ? null : job.requestedVersion as string,
      error: failure(job.error),
    },
  };
}

export function parseCloakKernelRelease(value: unknown): CloakKernelRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("内核版本信息格式无效");
  const row = value as Record<string, unknown>;
  if (!isKernelVersion(row.version) || typeof row.platform !== "string" || !row.platform
    || typeof row.checkedAt !== "string" || !row.checkedAt || !Number.isFinite(Date.parse(row.checkedAt))) throw new Error("内核版本信息格式无效");
  return { version: row.version, platform: row.platform, checkedAt: row.checkedAt };
}

export function parseCloakLicense(value: unknown): CloakLicenseStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("激活码状态格式无效");
  const row = value as Record<string, unknown>;
  if (typeof row.configured !== "boolean" || !(row.key === null || typeof row.key === "string")
    || !(row.plan === null || typeof row.plan === "string") || !(row.expires === null || typeof row.expires === "string")) throw new Error("激活码状态格式无效");
  return { configured: row.configured, key: row.key, plan: row.plan, expires: row.expires };
}

export function parseCloakSeats(value: unknown): CloakLicenseSeats {
  const isCount = (count: unknown): count is number | null =>
    count === null || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
  const row = value as Partial<CloakLicenseSeats> | null;
  if (!row || !isCount(row.active) || !isCount(row.limit)) throw new Error("授权席位返回格式无效");
  return { active: row.active, limit: row.limit };
}

export function parseCloakLocalSessions(value: unknown): CloakLocalSession[] {
  if (!Array.isArray(value)) throw new Error("本机会话列表返回格式无效");
  return value.map((item: unknown) => {
    const row = item as Partial<CloakLocalSession> | null;
    if (!row || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.residual !== "boolean" ||
      (row.state !== "starting" && row.state !== "running" && row.state !== "stopping" && row.state !== "unknown")) {
      throw new Error("本机会话状态返回格式无效");
    }
    return { id: row.id, name: row.name, state: row.state, residual: row.residual };
  });
}
