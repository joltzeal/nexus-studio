import { isNativeRaccoon } from "../../raccoon/runtime";
import { nativeApi } from "../../raccoon/api";
import { shardConnectionId } from "../../raccoon/fingerprint-api";
import { invoke } from "@tauri-apps/api/core";

/** This computer's monitor: width and height in CSS pixels, and its pixel ratio. */
export type HostScreen = [number, number, number];

/// This computer's monitor (lib.rs `host_screen`); null on a machine with
/// none, or when it could not be asked.
export function hostScreen(): Promise<HostScreen | null> {
  if (isNativeRaccoon()) {
    return nativeApi.call("shardbrowser_host_screen", { connectionId: shardConnectionId() }).then((value) => {
      if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== "number" || !Number.isFinite(part) || part <= 0)) return null;
      return value as HostScreen;
    }, () => null);
  }
  return invoke<HostScreen | null>("host_screen").then((v) => v ?? null, () => null);
}
