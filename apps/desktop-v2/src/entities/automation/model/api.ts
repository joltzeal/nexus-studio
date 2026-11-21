import { isNativeRaccoon } from "../../../raccoon/runtime";
import { nativeAutomationApi } from "../../../raccoon/automation/api";
import { invoke } from "../../../shared/api/invoke";
import type {
  Bundle,
  DisplayInfo,
  ModuleInfo,
  Picked,
  Project,
  RunState,
  TrafficAction,
  TrafficRule,
} from "./types";

export const automationAvailable = () => isNativeRaccoon() ? nativeAutomationApi.available() : invoke<boolean>("automation_available");
export const automationList = () => isNativeRaccoon() ? nativeAutomationApi.list() : invoke<Project[]>("automation_list");
export const automationCreate = (name: string) => isNativeRaccoon() ? nativeAutomationApi.create(name) : invoke<Project>("automation_create", { name });
export const automationSave = (project: Project) => isNativeRaccoon() ? nativeAutomationApi.save(project) : invoke<Project>("automation_save", { project });
export const automationDelete = (id: string) => isNativeRaccoon() ? nativeAutomationApi.delete(id) : invoke("automation_delete", { id });
export const automationDuplicate = (id: string) => isNativeRaccoon() ? nativeAutomationApi.duplicate(id) : invoke<Project>("automation_duplicate", { id });

// ---- Live session ----

export const automationAttach = (profileId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.attach(profileId) : invoke("automation_attach", { profileId });
export const automationDetach = (profileId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.detach(profileId) : invoke("automation_detach", { profileId });
export const automationAttached = (profileId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.attached(profileId) : invoke<boolean>("automation_attached", { profileId });
export const automationScreencast = (
  profileId: string,
  on: boolean,
  width: number,
  height: number,
) => isNativeRaccoon() ? nativeAutomationApi.screencast(profileId, on, width, height) : invoke("automation_screencast", { profileId, on, width, height });
export const automationCall = <T = unknown>(
  profileId: string,
  method: string,
  params: Record<string, unknown> = {},
) => isNativeRaccoon() ? nativeAutomationApi.call<T>(profileId, method, params) : invoke<T>("automation_call", { profileId, method, params });

/** `restart`: a profile already open without automation is closed and started again with it. */
export const automationLaunch = (profileId: string, restart = false) =>
  isNativeRaccoon() ? nativeAutomationApi.launch(profileId, restart) : invoke<number>("automation_launch", restart ? { profileId, restart } : { profileId });

export const automationPick = (profileId: string, x: number, y: number) =>
  isNativeRaccoon() ? nativeAutomationApi.pick(profileId, x, y) : invoke<Picked>("automation_pick", { profileId, x, y });

// ---- Runs ----

export const automationRun = (projectId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.run(projectId) : invoke("automation_run", { projectId });
export const automationRunStop = (projectId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.runStop(projectId) : invoke("automation_run_stop", { projectId });
export const automationRunStatus = (projectId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.runStatus(projectId) : invoke<RunState | null>("automation_run_status", { projectId });
export const automationFleet = () => isNativeRaccoon() ? nativeAutomationApi.fleet() : invoke<RunState[]>("automation_fleet");
export const automationFleetWindow = () => isNativeRaccoon() ? nativeAutomationApi.fleetWindow() : invoke("automation_fleet_window");

// ---- Modules, export, display ----

export const automationTlsFingerprints = () =>
  isNativeRaccoon() ? nativeAutomationApi.tlsFingerprints() : invoke<string[]>("automation_tls_fingerprints");
export const automationModules = () => isNativeRaccoon() ? nativeAutomationApi.modules() : invoke<ModuleInfo[]>("automation_modules");

/** What a module asks to be allowed to call, and what it was allowed. */
export type ModulePermissions = {
  asks: { modules: string[]; flows: string[]; vars: string[]; reason: string };
  granted: { decided_for: string; call_modules: string[]; call_flows: string[] };
};
export const automationModulePermissions = (id: string) =>
  isNativeRaccoon() ? nativeAutomationApi.modulePermissions(id) : invoke<ModulePermissions>("automation_module_permissions", { id });
export const automationModuleGrant = (id: string, modules: string[], flows: string[]) =>
  isNativeRaccoon() ? nativeAutomationApi.moduleGrant(id, modules, flows) : invoke("automation_module_grant", { id, modules, flows });
export const automationModuleInstall = (path: string) =>
  isNativeRaccoon() ? nativeAutomationApi.moduleInstall(path) : invoke<ModuleInfo>("automation_module_install", { path });
export const automationModuleRemove = (id: string) =>
  isNativeRaccoon() ? nativeAutomationApi.moduleRemove(id) : invoke("automation_module_remove", { id });
export const automationModulesDir = () => isNativeRaccoon() ? nativeAutomationApi.modulesDir() : invoke<string>("automation_modules_dir");
export const automationExport = (projectId: string) =>
  isNativeRaccoon() ? nativeAutomationApi.export(projectId) : invoke<Bundle>("automation_export", { projectId });
export const automationImport = (bundle: Bundle) =>
  isNativeRaccoon() ? nativeAutomationApi.import(bundle) : invoke<Project>("automation_import", { bundle });
export const automationDisplay = () => isNativeRaccoon() ? nativeAutomationApi.display() : invoke<DisplayInfo>("automation_display");

// ---- Request interception (Traffic domain) ----

/** Mounts rules on the live profile. targetId omitted = profile scope. Rules go
 *  as a JSON string, which is what the Traffic domain expects. */
export const trafficMount = (
  profileId: string,
  rules: TrafficRule[],
  targetId?: string,
) =>
  automationCall<{ ruleSetId: string }>(profileId, "Traffic.mount", {
    rules: JSON.stringify(rules),
    ...(targetId ? { targetId } : {}),
  });

/** Hot-swaps the live profile's proxy without a restart. Empty = direct. */
export const trafficSetProxy = (profileId: string, proxy?: string) =>
  automationCall(profileId, "Traffic.setProxy", proxy ? { proxy } : {});

export const trafficObserve = (profileId: string, enabled: boolean) =>
  automationCall(profileId, "Traffic.observe", { enabled });

export const trafficUnmount = (profileId: string, ruleSetId: string) =>
  automationCall(profileId, "Traffic.unmount", { ruleSetId });

export const trafficClear = (profileId: string, targetId?: string) =>
  automationCall(profileId, "Traffic.clear", targetId ? { targetId } : {});

export const trafficList = (profileId: string, targetId?: string) =>
  automationCall<{ rulesJson: string }>(
    profileId,
    "Traffic.list",
    targetId ? { targetId } : {},
  );

/** Answers a paused request. `action` omitted = let it continue unchanged. */
export const trafficResolve = (
  profileId: string,
  requestId: string,
  action?: TrafficAction,
) =>
  automationCall(profileId, "Traffic.resolve", {
    requestId,
    ...(action ? { action: JSON.stringify(action) } : {}),
  });

// ---- Script domain (isolated-world JS execution) ----

/** Runs JS in the page's isolated world (default) or main world. Returns the
 *  result serialized to JSON. */
export const scriptRun = (
  profileId: string,
  source: string,
  world?: "isolated" | "main",
) =>
  automationCall<{ result: string }>(profileId, "Script.run", {
    source,
    ...(world ? { world } : {}),
  });
