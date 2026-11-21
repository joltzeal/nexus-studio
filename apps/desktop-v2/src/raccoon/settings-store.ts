import { create } from "zustand";
import { useLang, loadLang } from "../shared/i18n";
import { applyStoredMotion } from "../shared/model/motion";
import { applyStoredInterfaceSize } from "../shared/model/interfaceSize";
import { workbenchSettingsApi, type WorkbenchSettings } from "./settings-api";

export const useNativeSettings = create<{ value: WorkbenchSettings | null; error: string | null }>(() => ({ value: null, error: null }));
let loading: Promise<WorkbenchSettings> | null = null;

export function loadNativeSettings(): Promise<WorkbenchSettings> {
  return loading ??= workbenchSettingsApi.get().then(async (value) => {
    await loadLang(value.language);
    useLang.getState().setLang(value.language);
    useNativeSettings.setState({ value, error: null });
    return value;
  }).catch((error: unknown) => {
    useNativeSettings.setState({ error: error instanceof Error ? error.message : "设置读取失败" });
    throw error;
  }).finally(() => { loading = null; });
}

export async function saveNativeSettings(value: WorkbenchSettings) {
  await loadLang(value.language);
  const saved = await workbenchSettingsApi.save(value);
  useLang.getState().setLang(saved.language);
  useNativeSettings.setState({ value: saved, error: null });
  return saved;
}

/** Initializes the native settings consumers when the native Settings module loads. */
applyStoredMotion();
applyStoredInterfaceSize();
void loadNativeSettings().catch(() => {});
