let native = false;

export function activateNativeRaccoon() {
  native = true;
}

export function isNativeRaccoon() {
  return native;
}

let connectionId: string | null = null;

export function nativePreferenceKey(base: string) {
  return native ? `raccoon.v2.${connectionId ?? "unconfigured"}.${base}` : base;
}

export function setNativePreferenceConnection(id: string | null) {
  connectionId = id;
}
