import { useTrash, type TrashEntry } from "../entities/trash";
import { useProfile, useProfileUi } from "../entities/profile";
import { useTags } from "../entities/tag";
import { confirmModal } from "../shared/lib/confirm";
import { storeBus } from "../shared/lib/storeBus";
import { toast } from "../shared/model/toast";
import { t } from "../shared/i18n";
import { nativeTrashApi, nativeTrashConnection } from "./trash-api";
import type { NativeWorkspace } from "./controller";
import { workspace } from "./store";

let generation = 0;
let read = 0;
let firstRead: Promise<void> | null = null;
const current = (connectionId: string, epoch: number) => workspace.state.connectionId === connectionId && generation === epoch;

async function refreshProfiles(connectionId: string, epoch: number): Promise<void> {
  try { await workspace.refresh(); }
  catch (error) {
    if (current(connectionId, epoch)) toast.fail({ title: "Profile 列表读取失败，请刷新核对", detail: error });
  }
}

async function restoreIds(ids: string[], connectionId: string, epoch: number): Promise<void> {
  if (!ids.length) return;
  const failed: unknown[] = [];
  for (const id of ids) {
    if (!current(connectionId, epoch)) break;
    try { await nativeTrashApi.restore(id, connectionId); }
    catch (error) { failed.push(error); }
  }
  if (!current(connectionId, epoch)) return;
  await Promise.all([refreshProfiles(connectionId, epoch), useTrash.getState().reload()]);
  if (!current(connectionId, epoch)) return;
  storeBus.emit("trash", "trash");
  if (failed.length) toast.fail({ title: t("useProfile.restoreSomeFailed", { failed: failed.length, total: ids.length }), detail: failed[0] });
  else toast.ok(t("useTrash.restoredMany", { n: ids.length }));
}

/** Bind this function to the original table's deleteMany / MoveToTrash action. */
export async function moveNativeProfilesToTrash(ids: string[]): Promise<string[]> {
  const connectionId = nativeTrashConnection();
  const epoch = generation;
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = unique.map((id) => workspace.state.profiles.find((row) => row.id === id && row.connectionId === connectionId));
  if (rows.some((row) => !row || row.state !== "stopped")) {
    toast.fail({ title: "移入回收站失败", detail: "请先停止选中的 Profile，并核对未知状态或待处理操作" });
    return [];
  }
  try {
    const moved = await nativeTrashApi.move(unique, connectionId);
    if (!current(connectionId, epoch)) return moved;
    const gone = new Set(moved);
    useProfileUi.setState((state) => ({ selected: new Set([...state.selected].filter((id) => !gone.has(id))) }));
    storeBus.emit("trash", "profiles");
    await Promise.all([refreshProfiles(connectionId, epoch), useTrash.getState().reload({ quiet: true })]);
    if (!current(connectionId, epoch)) return moved;
    toast.undo(moved.length === 1 ? t("useProfile.movedToTrashOne", { name: rows[0]?.name ?? "" }) : t("useProfile.movedToTrash", { n: moved.length }), () => {
      if (current(connectionId, epoch)) void restoreIds(moved, connectionId, epoch);
    });
    return moved;
  } catch (error) {
    if (current(connectionId, epoch)) {
      toast.fail({ title: "移入回收站失败", detail: error });
      // A lost response may follow a committed transaction. Re-read both lists.
      await Promise.all([refreshProfiles(connectionId, epoch), useTrash.getState().reload({ quiet: true })]);
    }
    return [];
  }
}

/** Preserve the original TrashPage and confirmations, with connection-scoped async state. */
export function connectTrash(owner: NativeWorkspace): () => void {
  let connectionId = owner.state.connectionId;
  const reset = () => {
    generation += 1;
    read += 1;
    firstRead = null;
    useTrash.setState({ status: "idle", items: [], selected: new Set(), search: "", error: null, readAt: 0, stale: true });
  };
  reset();

  async function load(quiet = false): Promise<void> {
    const id = owner.state.connectionId;
    if (!id) { reset(); return; }
    const epoch = generation;
    const ticket = ++read;
    const initial = useTrash.getState().status !== "ready";
    if (initial) useTrash.setState({ status: "loading", error: null });
    try {
      const items = await nativeTrashApi.list(id);
      if (!current(id, epoch) || ticket !== read) return;
      const known = new Set(items.map((item) => item.id));
      useTrash.setState((state) => ({ items, selected: new Set([...state.selected].filter((id) => known.has(id))), status: "ready", error: null, stale: false, readAt: Date.now() }));
    } catch (error) {
      if (!current(id, epoch) || ticket !== read) return;
      useTrash.setState({ status: "error", error: String(error), stale: true });
      if (!quiet) toast.fail({ title: t("useTrash.loadFailed"), detail: error });
    }
  }

  async function purge(entries: TrashEntry[], empty = false): Promise<void> {
    const id = nativeTrashConnection();
    const epoch = generation;
    const ids = [...new Set(entries.map((entry) => entry.id))];
    if (!ids.length) return;
    const confirmed = await confirmModal({
      title: empty ? t("useTrash.emptyTitle") : ids.length === 1 ? t("useTrash.purgeTitle", { name: entries[0].name }) : t("useTrash.purgeManyTitle", { n: ids.length }),
      message: t("raccoon.trash.purgeMessage"),
      confirmLabel: empty ? t("useTrash.emptyConfirm") : t("useTrash.purgeManyConfirm", { n: ids.length }),
      danger: true,
    });
    if (confirmed !== true || !current(id, epoch)) return;
    const done: string[] = [];
    const errors: unknown[] = [];
    for (const profileId of ids) {
      if (!current(id, epoch)) break;
      try { await nativeTrashApi.purge(profileId, id); done.push(profileId); }
      catch (error) { errors.push(error); }
    }
    if (!current(id, epoch)) return;
    await useTags.getState().reload();
    await Promise.all([load(true), refreshProfiles(id, epoch)]);
    if (!current(id, epoch)) return;
    if (errors.length) toast.fail({ title: t("useTrash.purgedSome", { failed: errors.length }), detail: errors[0] });
    else toast.ok(done.length === 1 ? t("useTrash.deletedOne") : t("useTrash.deletedMany", { n: done.length }));
  }

  const init = (opts?: { quiet?: boolean }) => {
    if (firstRead) return firstRead;
    const request = load(opts?.quiet);
    firstRead = request;
    void request.finally(() => { if (firstRead === request) firstRead = null; });
    return request;
  };
  useTrash.setState({
    init,
    reload: (opts) => load(opts?.quiet),
    refresh: async () => {
      const state = useTrash.getState();
      if (state.status !== "ready" || state.stale || Date.now() - state.readAt >= 30_000) await init({ quiet: true });
    },
    restore: async (entry) => {
      const id = nativeTrashConnection();
      const epoch = generation;
      try {
        const restored = await nativeTrashApi.restore(entry.id, id);
        if (!current(id, epoch)) return;
        await Promise.all([load(true), refreshProfiles(id, epoch)]);
        if (!current(id, epoch)) return;
        toast.ok(t("useTrash.restored", { name: restored.name }), {
          action: { label: t("toast.showInList"), run: () => { if (current(id, epoch)) void useProfileUi.getState().showInList(restored.id); } },
        });
      } catch (error) {
        if (!current(id, epoch)) return;
        toast.fail({ title: t("useTrash.restoreFailed", { name: entry.name }), detail: error });
        await Promise.all([load(true), refreshProfiles(id, epoch)]);
      }
    },
    restoreMany: (entries) => entries.length === 1 ? useTrash.getState().restore(entries[0]) : restoreIds(entries.map((entry) => entry.id), nativeTrashConnection(), generation),
    purge: (entry) => purge([entry]),
    purgeMany: (entries) => purge(entries),
    empty: () => purge([...useTrash.getState().items], true),
  });
  useProfile.setState({ restoreMany: (ids) => restoreIds(ids, nativeTrashConnection(), generation) });
  const unsubscribe = owner.subscribe(() => {
    if (connectionId === owner.state.connectionId) return;
    connectionId = owner.state.connectionId;
    reset();
    if (connectionId) void init({ quiet: true });
  });
  const unsubscribeBus = storeBus.on("trash", (from) => {
    if (from !== "trash") useTrash.setState({ stale: true });
  });
  return () => { unsubscribe(); unsubscribeBus(); reset(); };
}
