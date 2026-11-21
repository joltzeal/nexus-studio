import {
  parseBoolean, parseBundle, parseCapabilities, parseCount, parseDisplay,
  parseJson, parseModule, parseModules, parseOptionalRun, parsePermissions,
  parsePicked, parseProject, parseProjects, parseRuns, parseString, parseStrings, parseVoid,
} from "./schemas.ts";

const COMMANDS = {
  available: "browser_automation_available",
  list: "browser_automation_list",
  create: "browser_automation_create",
  save: "browser_automation_save",
  delete: "browser_automation_delete",
  duplicate: "browser_automation_duplicate",
  attach: "browser_automation_attach",
  detach: "browser_automation_detach",
  attached: "browser_automation_attached",
  screencast: "browser_automation_screencast",
  call: "browser_automation_call",
  launch: "browser_automation_launch",
  pick: "browser_automation_pick",
  run: "browser_automation_run",
  run_stop: "browser_automation_run_stop",
  run_status: "browser_automation_run_status",
  run_reconcile: "browser_automation_run_reconcile",
  fleet: "browser_automation_fleet",
  fleet_window: "browser_automation_fleet_window",
  tls_fingerprints: "browser_automation_tls_fingerprints",
  modules: "browser_automation_modules",
  module_permissions: "browser_automation_module_permissions",
  module_grant: "browser_automation_module_grant",
  module_install: "browser_automation_module_install",
  module_remove: "browser_automation_module_remove",
  modules_dir: "browser_automation_modules_dir",
  export: "browser_automation_export",
  import: "browser_automation_import",
  display: "browser_automation_display",
  capabilities: "browser_automation_capabilities",
} as const;

const PARSERS = {
  available: parseBoolean, list: parseProjects, create: parseProject, save: parseProject,
  delete: parseVoid, duplicate: parseProject, attach: parseVoid, detach: parseVoid,
  attached: parseBoolean, screencast: parseVoid, call: parseJson, launch: parseCount, pick: parsePicked,
  run: parseJson, run_stop: parseVoid, run_status: parseOptionalRun, run_reconcile: parseOptionalRun, fleet: parseRuns,
  fleet_window: parseVoid, tls_fingerprints: parseStrings, modules: parseModules,
  module_permissions: parsePermissions, module_grant: parseVoid, module_install: parseModule,
  module_remove: parseVoid, modules_dir: parseString, export: parseBundle, import: parseProject,
  display: parseDisplay, capabilities: parseCapabilities,
};

export type AutomationCommand = keyof typeof COMMANDS;
export type AutomationReply<C extends AutomationCommand> = ReturnType<(typeof PARSERS)[C]>;
export type AutomationTransport = {
  call(command: string, args?: Record<string, unknown>): Promise<unknown>;
};

export class AutomationWorkspaceChanged extends Error {
  code = "automation_workspace_changed";
  constructor() { super("Workspace 已切换，自动化结果属于之前的连接"); }
}

export class NativeAutomationClient {
  private connectionId: string | null = null;
  private generation = 0;
  private pendingRuns = new Map<string, { id: string; active: number; confirmed: boolean }>();
  private transport: AutomationTransport;
  private operationId: () => string;

  constructor(transport: AutomationTransport, operationId: () => string = () => crypto.randomUUID()) {
    this.transport = transport;
    this.operationId = operationId;
  }

  select(connectionId: string | null) {
    if (this.connectionId === connectionId) return;
    this.connectionId = connectionId;
    this.generation++;
  }
  connection = () => this.connectionId;
  scope = () => this.generation;
  isCurrent = (scope: number) => scope === this.generation;

  async request<C extends AutomationCommand>(command: C, args: Record<string, unknown> = {}): Promise<AutomationReply<C>> {
    const connectionId = this.connectionId;
    const generation = this.generation;
    if (!connectionId) throw new Error("请先选择 Workspace");
    if ("connectionId" in args && args.connectionId !== connectionId) throw new AutomationWorkspaceChanged();
    const request: Record<string, unknown> = { ...args, connectionId };
    if (command === "save") parseProject(request.project);
    if (command === "import") parseBundle(request.bundle);
    let runKey: string | undefined;
    let run: { id: string; active: number; confirmed: boolean } | undefined;
    if (command === "run") {
      if (typeof request.projectId !== "string" || !request.projectId) throw new Error("请选择自动化项目");
      runKey = JSON.stringify([connectionId, request.projectId]);
      run = this.pendingRuns.get(runKey) ?? { id: this.operationId(), active: 0, confirmed: false };
      run.active++;
      this.pendingRuns.set(runKey, run);
      request.operationId = run.id;
    }
    try {
      const value = await this.transport.call(COMMANDS[command], request);
      const parsed = PARSERS[command](value) as AutomationReply<C>;
      if (run) run.confirmed = true;
      if (generation !== this.generation) throw new AutomationWorkspaceChanged();
      return parsed;
    } finally {
      if (run) run.active--;
      if (runKey && run?.confirmed && run.active === 0) this.pendingRuns.delete(runKey);
    }
  }

  /** Cleanup uses the connection captured when the preview session was opened. */
  async release(connectionId: string, profileId: string) {
    await this.transport.call(COMMANDS.detach, { connectionId, profileId });
  }
}
