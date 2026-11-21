import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isKernelVersion,
  parseCloakKernelRelease,
  parseCloakKernelStatus,
  parseCloakLicense,
  parseCloakLocalSessions,
  parseCloakSeats,
} from "./cloakbrowser-contract.ts";

const status = {
  cacheDir: "/synthetic/cache",
  platform: "darwin-arm64",
  activationConfigured: true,
  installed: [{ version: "155.0.8059.39.2", binaryPath: "/synthetic/browser" }],
  download: {
    phase: "downloading",
    percent: 42.5,
    downloadedMb: 12,
    totalMb: 100,
    attempt: 2,
    version: null,
    requestedVersion: "155.0.8059.39.2",
    error: null,
  },
};

test("accepts only full four or five segment kernel package versions", () => {
  assert.equal(isKernelVersion("155.0.8059.39.2"), true);
  assert.equal(isKernelVersion("154.0.8000.10"), true);
  for (const value of ["155", "155.0.1.2\n", "../155.0.1.2", "155..1.2", "155.0.1.2.3.4", 155]) {
    assert.equal(isKernelVersion(value), false);
  }
});

test("round-trips a structured CloakBrowser kernel status", () => {
  assert.deepEqual(parseCloakKernelStatus(status), status);
});

test("rejects malformed CloakBrowser kernel responses", () => {
  assert.throws(() => parseCloakKernelStatus({ ...status, installed: [{ version: "155", binaryPath: "/x" }] }), /内核状态/);
  assert.throws(() => parseCloakKernelStatus({ ...status, download: { ...status.download, phase: "paused" } }), /下载进度/);
  assert.throws(() => parseCloakKernelStatus({ ...status, download: { ...status.download, requestedVersion: "155" } }), /下载进度/);
  assert.throws(() => parseCloakKernelStatus({ ...status, download: { ...status.download, error: { code: "NETWORK", message: "失败" } } }), /下载进度/);
});

test("validates the latest release response", () => {
  const release = { version: "155.0.8059.39.2", platform: "darwin-arm64", checkedAt: "2026-10-25T10:00:00.000Z" };
  assert.deepEqual(parseCloakKernelRelease(release), release);
  assert.throws(() => parseCloakKernelRelease({ ...release, version: "latest" }), /版本信息/);
  assert.throws(() => parseCloakKernelRelease({ ...release, checkedAt: "yesterday" }), /版本信息/);
});

test("license state returns the saved plaintext key", () => {
  assert.deepEqual(
    parseCloakLicense({ configured: true, key: "cb_plain_text_key", plan: "pro", expires: "2027-01-01" }),
    { configured: true, key: "cb_plain_text_key", plan: "pro", expires: "2027-01-01" },
  );
  assert.deepEqual(
    parseCloakLicense({ configured: false, key: null, plan: null, expires: null }),
    { configured: false, key: null, plan: null, expires: null },
  );
  assert.throws(() => parseCloakLicense({ configured: true, key: 42, plan: null, expires: null }), /激活码状态/);
});

test("keeps unknown official seat counts distinct from zero local usage", () => {
  assert.deepEqual(parseCloakSeats({ active: null, limit: 5 }), { active: null, limit: 5 });
  assert.deepEqual(parseCloakSeats({ active: 0, limit: 5 }), { active: 0, limit: 5 });
  assert.throws(() => parseCloakSeats({ active: -1, limit: 5 }), /授权席位/);
  assert.deepEqual(parseCloakLocalSessions([]), []);
});

test("requires positive recovery evidence before showing a session as residual", () => {
  const residual = { id: "synthetic-profile", name: "Profile A", state: "unknown", residual: true };
  assert.deepEqual(parseCloakLocalSessions([residual]), [residual]);
  assert.throws(() => parseCloakLocalSessions([{ ...residual, residual: "true" }]), /本机会话/);
});
