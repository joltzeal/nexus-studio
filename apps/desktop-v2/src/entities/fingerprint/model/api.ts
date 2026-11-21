import { isNativeRaccoon } from "../../../raccoon/runtime";
import { nativeFingerprintApi, nativeGpuCaps, nativeGpuCompat } from "../../../raccoon/fingerprint-api";
import { invoke } from "@tauri-apps/api/core";
import type { FingerprintEntry, GpuCompat, HostGlCaps } from "./types";

export const fingerprintList = () => isNativeRaccoon() ? nativeFingerprintApi.list() : invoke<FingerprintEntry[]>("fingerprint_list");
export const fingerprintDelete = (id: string) => isNativeRaccoon() ? nativeFingerprintApi.remove(id) : invoke("fingerprint_delete", { id });
export const fingerprintImport = (jsonText: string, idHint: string | null) => isNativeRaccoon() ? nativeFingerprintApi.import(jsonText, idHint) : invoke<FingerprintEntry>("fingerprint_import", { jsonText, idHint });
export const fingerprintDir = () => isNativeRaccoon() ? nativeFingerprintApi.directory() : invoke<string>("fingerprint_dir");

/// Slow on the first call: it starts the engine off-screen and asks it what the
/// GPU supports. Cached in Rust against the engine build afterwards.
export const gpuCaps = (force = false) => isNativeRaccoon() ? nativeGpuCaps(force) : invoke<HostGlCaps>("gpu_caps", { force });
/// id -> compatibility. Empty map means "not known" (probe never ran or failed),
/// which must be shown as no verdict rather than as a clean one.
export const gpuCompat = () => isNativeRaccoon() ? nativeGpuCompat() : invoke<Record<string, GpuCompat>>("gpu_caps_compat");
