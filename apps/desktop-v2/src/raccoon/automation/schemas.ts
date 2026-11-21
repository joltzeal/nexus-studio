import type {
  Block, Branch, Bundle, DisplayInfo, ModuleInfo, Picked, Project, RunState,
} from "../../entities/automation/model/types.ts";

export type ModulePermissions = {
  asks: { modules: string[]; flows: string[]; vars: string[]; reason: string };
  granted: { decided_for: string; call_modules: string[]; call_flows: string[] };
};

export type AutomationCapabilities = {
  supported: boolean;
  reason: string;
  features: string[];
  inputMode: "native-motion" | "standard-cdp" | "unavailable";
};

function invalid(): never { throw new Error("自动化返回格式无效"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : invalid(); }
function count(value: unknown): number {
  const result = number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : invalid();
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(parse) : invalid();
}
function json(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { number(value); return; }
  if (Array.isArray(value)) { value.forEach(json); return; }
  const row = object(value);
  Object.values(row).forEach(json);
}
function branch(value: unknown): Branch {
  if (value === "next" || value === "stop" || value === "endpass") return value;
  const row = object(value);
  if (Object.keys(row).length !== 1) invalid();
  if ("goto" in row) return { goto: text(row.goto) };
  if ("retry" in row) return { retry: count(row.retry) };
  return invalid();
}
function block(value: unknown): Block {
  const row = object(value);
  text(row.id); text(row.kind); text(row.label);
  object(row.params); json(row.params);
  bool(row.enabled); array(row.secrets, text);
  number(row.x); number(row.y); branch(row.on_done); branch(row.on_fail);
  return row as Block;
}
export function parseProject(value: unknown): Project {
  const row = object(value);
  text(row.id); text(row.name); text(row.notes);
  array(row.blocks, block);
  const run = object(row.run);
  const threads = count(run.threads);
  if (threads < 1 || threads > 64 || number(run.hours) < 0) invalid();
  count(run.loops); array(run.profiles, text); text(run.start);
  count(row.created_at); count(row.updated_at);
  if (row.revision !== undefined) count(row.revision);
  if (row.rules !== undefined) array(row.rules, (rule) => { object(rule); json(rule); return rule; });
  return row as Project;
}
export const parseProjects = (value: unknown) => array(value, parseProject);

export function parseRunState(value: unknown): RunState {
  const row = object(value);
  text(row.project_id); text(row.project_name); count(row.started_at); bool(row.running);
  if (row.connection_id !== undefined) text(row.connection_id);
  if (row.run_id !== undefined) text(row.run_id);
  array(row.workers, (worker) => {
    const entry = object(worker);
    text(entry.profile_id); text(entry.profile_name);
    count(entry.pass); count(entry.step); count(entry.steps_total); text(entry.note);
    if (!["queued", "starting", "running", "done", "failed", "stopped", "reconciling", "interrupted", "persistence_error"].includes(text(entry.status))) invalid();
    return entry;
  });
  array(row.log, text);
  return row as RunState;
}
export const parseRuns = (value: unknown) => array(value, parseRunState);
export const parseOptionalRun = (value: unknown) => value === null ? null : parseRunState(value);

export function parseBundle(value: unknown): Bundle {
  const row = object(value);
  count(row.format); count(row.exported_at); parseProject(row.project);
  array(row.modules, text);
  if (row.module_files !== undefined) array(row.module_files, (file) => {
    const entry = object(file); text(entry.id); text(entry.wasm); return entry;
  });
  array(row.needs, (need) => {
    const entry = object(need); text(entry.block_id); text(entry.label); array(entry.params, text); return entry;
  });
  return row as Bundle;
}
export function parseModule(value: unknown): ModuleInfo {
  const row = object(value);
  text(row.id); text(row.name); text(row.path); text(row.error);
  array(row.blocks, (spec) => {
    const entry = object(spec);
    text(entry.kind); text(entry.label);
    if (entry.about !== undefined) text(entry.about);
    if (entry.group !== undefined) text(entry.group);
    if (entry.params !== undefined) array(entry.params, (parameter) => {
      const param = object(parameter);
      text(param.name); text(param.label);
      if (param.kind !== undefined) text(param.kind);
      if (param.hint !== undefined) text(param.hint);
      if (param.secret !== undefined) bool(param.secret);
      if (param.default !== undefined) json(param.default);
      return param;
    });
    return entry;
  });
  return row as ModuleInfo;
}
export const parseModules = (value: unknown) => array(value, parseModule);
export function parsePermissions(value: unknown): ModulePermissions {
  const row = object(value);
  const asks = object(row.asks);
  array(asks.modules, text); array(asks.flows, text); array(asks.vars, text); text(asks.reason);
  const granted = object(row.granted);
  text(granted.decided_for); array(granted.call_modules, text); array(granted.call_flows, text);
  return row as ModulePermissions;
}
export function parsePicked(value: unknown): Picked {
  const row = object(value);
  text(row.selector); text(row.tag); text(row.label);
  number(row.x); number(row.y); array(row.tried, text);
  return row as Picked;
}
export function parseDisplay(value: unknown): DisplayInfo {
  const row = object(value);
  text(row.server); bool(row.limited); text(row.note);
  bool(row.browser_placement); bool(row.panels);
  return row as DisplayInfo;
}
export function parseCapabilities(value: unknown): AutomationCapabilities {
  const row = object(value);
  bool(row.supported); text(row.reason); array(row.features, text);
  if (!["native-motion", "standard-cdp", "unavailable"].includes(text(row.inputMode))) invalid();
  return row as AutomationCapabilities;
}
export const parseBoolean = bool;
export const parseString = text;
export const parseStrings = (value: unknown) => array(value, text);
export const parseCount = count;
export function parseJson(value: unknown): unknown { json(value); return value; }
export function parseVoid(value: unknown): void { if (value !== undefined && value !== null) invalid(); }
