import type { Bookmark } from "../entities/bookmark/model/types";
import type {
  ExtensionEntry,
  ExtensionFlag,
  ExtensionImport,
  ExtensionSource,
  ExtensionUpdate,
  Grant,
  LinkResult,
  UpdateResult,
} from "../entities/extension/model/types";
import { nativeApi } from "./api";
import { shardConnectionId } from "./fingerprint-api";
import { workspace } from "./store";

type Row = Record<string, unknown>;

const UPDATE_STATES = new Set([
  "unlinked", "unchecked", "current", "available", "downloading", "ready",
  "waiting", "applying", "confirm", "failed", "needs_engine", "id_conflict",
]);
const UPDATE_PHASES = new Set(["download", "verify", "unpack", "apply"]);
const UPDATE_FLAGS = new Set<ExtensionFlag>(["malware", "policy_violation", "potentially_uws"]);
const GRANT_KINDS = new Set([
  "permission", "host", "script_host", "main_world", "connectable",
  "web_resource", "manifest_version", "override",
]);

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Row;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}格式无效`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}格式无效`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value !== null && typeof value !== "boolean") throw new Error(`${label}格式无效`);
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label}格式无效`);
  return value;
}

function bookmark(value: unknown): Bookmark {
  const item = row(value, "书签");
  const parsed: Bookmark = {
    id: text(item.id, "书签 ID"),
    title: text(item.title, "书签标题"),
    url: text(item.url, "书签地址"),
    folder: text(item.folder, "书签 Folder"),
  };
  if (item.root !== undefined) parsed.root = text(item.root, "书签根目录");
  if (item.path !== undefined) parsed.path = stringList(item.path, "书签路径");
  return parsed;
}

function source(value: unknown): ExtensionSource {
  const item = row(value, "扩展来源");
  if (item.kind === "webstore") return { kind: "webstore", id: text(item.id, "Web Store ID") };
  if (item.kind === "url") return { kind: "url", url: text(item.url, "扩展来源地址") };
  throw new Error("扩展来源格式无效");
}

function extension(value: unknown): ExtensionEntry {
  const item = row(value, "扩展");
  const parsed: ExtensionEntry = {
    id: text(item.id, "扩展 ID"),
    name: text(item.name, "扩展名称"),
    version: text(item.version, "扩展版本"),
    description: text(item.description, "扩展描述"),
    icon: text(item.icon, "扩展图标"),
    path: text(item.path, "扩展路径"),
    size_bytes: integer(item.size_bytes, "扩展大小"),
    added_at: text(item.added_at, "扩展添加时间"),
  };
  if (item.source !== undefined) parsed.source = source(item.source);
  return parsed;
}

function grant(value: unknown): Grant {
  const item = row(value, "扩展权限");
  const kind = text(item.kind, "扩展权限类型");
  if (!GRANT_KINDS.has(kind)) throw new Error("扩展权限类型格式无效");
  return { kind: kind as Grant["kind"], value: text(item.value, "扩展权限值") };
}

function update(value: unknown): ExtensionUpdate {
  const item = row(value, "扩展更新");
  const state = text(item.state, "扩展更新状态");
  if (!UPDATE_STATES.has(state)) throw new Error("扩展更新状态格式无效");
  if (!Array.isArray(item.waiting_on)) throw new Error("扩展更新等待项格式无效");
  if (!Array.isArray(item.flags) || item.flags.some((flag) => typeof flag !== "string" || !UPDATE_FLAGS.has(flag as ExtensionFlag))) {
    throw new Error("扩展更新风险标记格式无效");
  }
  let progress: ExtensionUpdate["progress"] = null;
  if (item.progress !== null) {
    const value = row(item.progress, "扩展更新进度");
    const phase = text(value.phase, "扩展更新阶段");
    if (!UPDATE_PHASES.has(phase)) throw new Error("扩展更新阶段格式无效");
    progress = {
      phase: phase as NonNullable<ExtensionUpdate["progress"]>["phase"],
      received: integer(value.received, "扩展更新已接收大小"),
      total: integer(value.total, "扩展更新总大小"),
    };
  }
  let confirm: ExtensionUpdate["confirm"];
  if (item.confirm !== undefined) {
    const value = row(item.confirm, "扩展更新确认");
    if (value.reason !== "permissions" && value.reason !== "identity") throw new Error("扩展更新确认原因格式无效");
    if (!Array.isArray(value.grown)) throw new Error("扩展新增权限格式无效");
    confirm = {
      reason: value.reason,
      grown: value.grown.map(grant),
    };
    if (value.names !== undefined) {
      const names = row(value.names, "扩展名称变更");
      confirm.names = { old: text(names.old, "原扩展名称"), new: text(names.new, "新扩展名称") };
    }
    if (value.overlap !== undefined) {
      if (typeof value.overlap !== "number" || !Number.isFinite(value.overlap) || value.overlap < 0 || value.overlap > 1) {
        throw new Error("扩展文件相似度格式无效");
      }
      confirm.overlap = value.overlap;
    }
  }
  return {
    id: text(item.id, "扩展更新 ID"),
    state: state as ExtensionUpdate["state"],
    installed: text(item.installed, "已安装扩展版本"),
    latest: nullableText(item.latest, "最新扩展版本"),
    size: nullableInteger(item.size, "扩展更新大小"),
    first_seen: nullableInteger(item.first_seen, "扩展更新首次发现时间"),
    ready_since: nullableInteger(item.ready_since, "扩展更新就绪时间"),
    waiting_on: item.waiting_on.map((holder) => {
      const value = row(holder, "扩展占用 Profile");
      return { id: text(value.id, "Profile ID"), name: text(value.name, "Profile 名称") };
    }),
    progress,
    error: nullableText(item.error, "扩展更新错误"),
    checked_at: nullableInteger(item.checked_at, "扩展检查时间"),
    flags: item.flags as ExtensionFlag[],
    allowlisted: nullableBoolean(item.allowlisted, "扩展白名单状态"),
    skipped: nullableText(item.skipped, "跳过扩展版本"),
    needs_engine: nullableText(item.needs_engine, "扩展所需内核版本"),
    ...(confirm ? { confirm } : {}),
  };
}

function updateResult(value: unknown): UpdateResult {
  const item = row(value, "扩展更新结果");
  switch (item.result) {
    case "applied":
      return { result: "applied", from: text(item.from, "原扩展版本"), to: text(item.to, "新扩展版本") };
    case "waiting":
      if (!Array.isArray(item.waiting_on)) throw new Error("扩展更新等待项格式无效");
      return {
        result: "waiting",
        waiting_on: item.waiting_on.map((holder) => {
          const value = row(holder, "扩展占用 Profile");
          return { id: text(value.id, "Profile ID"), name: text(value.name, "Profile 名称") };
        }),
      };
    case "confirm":
      return { result: "confirm", update: update(item.update) };
    case "needs_engine":
      return { result: "needs_engine", version: text(item.version, "扩展所需内核版本") };
    case "not_served":
      return { result: "not_served" };
    case "current":
      return { result: "current" };
    default:
      throw new Error("扩展更新结果格式无效");
  }
}

function linkResult(value: unknown): LinkResult {
  const item = row(value, "扩展来源关联结果");
  if (item.result === "linked") {
    return {
      result: "linked",
      source: source(item.source),
      allowlisted: nullableBoolean(item.allowlisted, "扩展白名单状态"),
      update: item.update === null ? null : update(item.update),
    };
  }
  if (item.result === "confirm") {
    const names = row(item.names, "扩展名称变更");
    if (item.kin !== "same" && item.kin !== "unsure") throw new Error("扩展来源关系格式无效");
    if (!Array.isArray(item.flags) || item.flags.some((flag) => typeof flag !== "string" || !UPDATE_FLAGS.has(flag as ExtensionFlag))) {
      throw new Error("扩展风险标记格式无效");
    }
    if (typeof item.overlap !== "number" || !Number.isFinite(item.overlap) || item.overlap < 0 || item.overlap > 1) {
      throw new Error("扩展文件相似度格式无效");
    }
    return {
      result: "confirm",
      names: { old: text(names.old, "原扩展名称"), new: text(names.new, "新扩展名称") },
      installed: text(item.installed, "已安装扩展版本"),
      store: text(item.store, "Web Store 扩展版本"),
      overlap: item.overlap,
      kin: item.kin,
      allowlisted: nullableBoolean(item.allowlisted, "扩展白名单状态"),
      flags: item.flags as ExtensionFlag[],
    };
  }
  throw new Error("扩展来源关联结果格式无效");
}

async function scoped<T>(command: string, args: Row, parse: (value: unknown) => T): Promise<T> {
  const connectionId = shardConnectionId();
  const value = await nativeApi.call(command, { connectionId, ...args });
  if (workspace.state.connectionId !== connectionId) {
    throw new Error("Workspace 已切换，请回到原 ShardBrowser Workspace 核对操作结果");
  }
  return parse(value);
}

const nothing = () => undefined;

export const nativeBookmarkApi = {
  list: () => scoped("shardbrowser_bookmark_list", {}, (value) => {
    if (!Array.isArray(value)) throw new Error("书签列表格式无效");
    return value.map(bookmark);
  }),
  save: (entry: Bookmark) => scoped("shardbrowser_bookmark_save", { entry }, bookmark),
  remove: (id: string) => scoped("shardbrowser_bookmark_delete", { id }, nothing),
  removeMany: (ids: string[]) => scoped("shardbrowser_bookmark_delete_many", { ids }, nothing),
};

export const nativeExtensionApi = {
  list: () => scoped("shardbrowser_extension_list", {}, (value) => {
    if (!Array.isArray(value)) throw new Error("扩展列表格式无效");
    return value.map(extension);
  }),
  import: (paths: string[], separate: boolean) => scoped("shardbrowser_extension_import", { paths, separate }, (value): ExtensionImport => {
    const item = row(value, "扩展导入结果");
    if (!Array.isArray(item.added) || !Array.isArray(item.refused)) throw new Error("扩展导入结果格式无效");
    return {
      added: item.added.map(extension),
      refused: item.refused.map((refusal) => {
        const value = row(refusal, "扩展导入拒绝项");
        return { path: text(value.path, "扩展路径"), error: text(value.error, "扩展导入错误") };
      }),
    };
  }),
  importUrl: (url: string, separate: boolean) => scoped("shardbrowser_extension_import_url", { url, separate }, extension),
  remove: (id: string) => scoped("shardbrowser_extension_delete", { id }, nothing),
  updates: () => scoped("shardbrowser_extension_updates", {}, (value) => {
    if (!Array.isArray(value)) throw new Error("扩展更新列表格式无效");
    return value.map(update);
  }),
  checkUpdates: () => scoped("shardbrowser_extension_updates_check", {}, (value) => {
    if (!Array.isArray(value)) throw new Error("扩展更新列表格式无效");
    return value.map(update);
  }),
  update: (id: string, confirmed: boolean) => scoped("shardbrowser_extension_update", { id, confirmed }, updateResult),
  linkSource: (id: string, link: string, confirmed: boolean) => scoped("shardbrowser_extension_link_source", { id, link, confirmed }, linkResult),
  cancelUpdate: (id: string) => scoped("shardbrowser_extension_update_cancel", { id }, nothing),
  skipUpdate: (id: string, version: string) => scoped("shardbrowser_extension_update_skip", { id, version }, nothing),
};
