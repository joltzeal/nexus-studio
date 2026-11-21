import type { Bundle, Project } from "../../entities/automation/model/types";
import { nativeApi } from "../api";
import { automationClient, configureAutomationTransport } from "./context";

configureAutomationTransport((command, args) => nativeApi.call(command, args));

export const nativeAutomationApi = {
  available: () => automationClient.request("available"),
  list: () => automationClient.request("list"),
  create: (name: string) => automationClient.request("create", { name }),
  save: (project: Project) => automationClient.request("save", { project }),
  delete: (id: string) => automationClient.request("delete", { id }),
  duplicate: (id: string) => automationClient.request("duplicate", { id }),
  attach: (profileId: string) => automationClient.request("attach", { profileId }),
  detach: (profileId: string) => automationClient.request("detach", { profileId }),
  attached: (profileId: string) => automationClient.request("attached", { profileId }),
  screencast: (profileId: string, on: boolean, width: number, height: number) =>
    automationClient.request("screencast", { profileId, on, width, height }),
  call: <T = unknown>(profileId: string, method: string, params: Record<string, unknown> = {}) =>
    automationClient.request("call", { profileId, method, params }) as Promise<T>,
  launch: (profileId: string, restart = false) => automationClient.request("launch", { profileId, restart }),
  pick: (profileId: string, x: number, y: number) => automationClient.request("pick", { profileId, x, y }),
  run: (projectId: string) => automationClient.request("run", { projectId }),
  runStop: (projectId: string) => automationClient.request("run_stop", { projectId }),
  runStatus: (projectId: string) => automationClient.request("run_status", { projectId }),
  runReconcile: (projectId: string, confirmed = false) => automationClient.request("run_reconcile", { projectId, confirmed }),
  fleet: () => automationClient.request("fleet"),
  fleetWindow: () => automationClient.request("fleet_window"),
  tlsFingerprints: () => automationClient.request("tls_fingerprints"),
  modules: () => automationClient.request("modules"),
  modulePermissions: (id: string) => automationClient.request("module_permissions", { id }),
  moduleGrant: (id: string, modules: string[], flows: string[]) => automationClient.request("module_grant", { id, modules, flows }),
  moduleInstall: (path: string) => automationClient.request("module_install", { path }),
  moduleRemove: (id: string) => automationClient.request("module_remove", { id }),
  modulesDir: () => automationClient.request("modules_dir"),
  export: (projectId: string) => automationClient.request("export", { projectId }),
  import: (bundle: Bundle) => automationClient.request("import", { bundle }),
  display: () => automationClient.request("display"),
  capabilities: (profileId?: string) => automationClient.request("capabilities", { profileId }),
};
