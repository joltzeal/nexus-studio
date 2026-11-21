import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DataList, IconButton, Select, useLatched } from "@proxyshard/shardx-ui-kit";
import { DownloadIcon, EditIcon, RefreshIcon } from "../../../shared/icons";
import { toast } from "../../../shared/model/toast";
import { LoadError, LoadingRows } from "../../../shared/ui/ListStates";
import { useListLayout, type ListColumnDef } from "../../../shared/ui/listHeader";
import { fmtDay, isDcIsp } from "../../../shared/lib/utils";
import { useDialogLife } from "../../../shared/lib/useDialogLife";
import { storeBus } from "../../../shared/lib/storeBus";
import { t, useT } from "../../../shared/i18n";
import type { PsOrder } from "../../../entities/proxyshard";
import { psOrders, psRenew, refreshAfterPurchase } from "../../../entities/proxyshard";
import { PsImportModal } from "./PsImportModal";
import { PsTagModal } from "./PsTagModal";

/// Orders list: add DC/ISP proxies to the local list, edit the tag, or renew
/// an on-hold order. Mobile proxies are hidden (they aren't manageable from
/// here), and the list is paginated.
const PS_ORDERS_PAGE = 10;

type OrderColumn = "product" | "order" | "until" | "tag";
const tagOf = (o: PsOrder) => (o.tag && o.tag !== "none" ? o.tag : "");

// A table on the one list recipe (F5, craft target: a header row on the card
// color). Its columns size to their content and are the person's to size,
// move, hide and sort, saved under `shardx.psOrders.layout` (owner: layouts
// persist). The cycle ("monthly") stays off the line: it is on the
// dashboard, and the raw API word stays off the screen (WRITE-11).
const ORDER_COLUMNS: readonly ListColumnDef<OrderColumn, PsOrder>[] = [
  {
    id: "product", title: (t) => t("psOrdersCard.colProduct"), need: 160, min: 120, max: 400, shown: true, hideable: false, movable: false,
    text: (o) => o.product_name, compare: (a, b) => a.product_name.localeCompare(b.product_name),
  },
  {
    id: "order", title: (t) => t("psOrdersCard.colOrder"), need: 64, min: 56, max: 120, shown: true, hideable: true, movable: true,
    text: (o) => `#${o.order_id}`, role: "tabular", compare: (a, b) => a.order_id - b.order_id,
  },
  {
    id: "until", title: (t) => t("psOrdersCard.colUntil"), need: 88, min: 80, max: 200, shown: true, hideable: true, movable: true,
    text: (o) => (o.expires_at ? fmtDay(o.expires_at) : t("psOrdersCard.noEnd")), role: "tabular",
    // No end date sorts after every date.
    compare: (a, b) => (a.expires_at ?? "\uffff").localeCompare(b.expires_at ?? "\uffff"),
  },
  {
    id: "tag", title: (t) => t("psOrdersCard.colTag"), need: 72, min: 56, max: 240, shown: true, hideable: true, movable: true,
    text: tagOf, role: "secondary", compare: (a, b) => tagOf(a).localeCompare(tagOf(b)),
  },
];
/** The row's hover actions: Add to proxies (114 px) and More (24), 4 apart;
 *  on hold, Renew (52) too. */
const ACTIONS_TRACK = 144;
const ACTIONS_TRACK_ON_HOLD = 200;

export function PsOrdersCard() {
  const t = useT();
  const [status, setStatus] = useState("active");
  const [orders, setOrders] = useState<PsOrder[]>([]);
  // Loading from the first frame: no empty state flashes before the first read.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [offset, setOffset] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [importing, setImporting] = useState<PsOrder | null>(null);
  const [tagging, setTagging] = useState<PsOrder | null>(null);
  // Each stays mounted, with the order it opened on, through its exit (FEEL-01).
  const importLife = useDialogLife(importing != null);
  const importShown = useLatched(importing);
  const tagLife = useDialogLife(tagging != null);
  const tagShown = useLatched(tagging);

  // The last request wins: an answer for a status (or page) the user already
  // left must not land under the new one.
  const latest = useRef(0);
  const load = async (off = offset) => {
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const r = await psOrders({ status, offset: off, limit: PS_ORDERS_PAGE });
      if (mine !== latest.current) return;
      setOrders(r.orders ?? []);
      // `next` is a page URI when more results exist (nullable).
      setHasNext(!!r.next);
    } catch (e) {
      if (mine === latest.current) setError(String(e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  };
  // Reset to the first page whenever the status filter changes.
  useEffect(() => { setOffset(0); load(0); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  // The account changed (a buy, a top-up, a renewal): the page in view is read again.
  const reload = useRef(load);
  reload.current = load;
  useEffect(() => {
    const off = storeBus.on("proxyshard", () => { void reload.current(); });
    return () => { off(); };
  }, []);

  const setB = (id: number, v: boolean) => setBusy((s) => ({ ...s, [id]: v }));

  const renew = async (o: PsOrder) => {
    setB(o.order_id, true);
    try {
      await psRenew(o.order_id);
      toast.ok(t("psOrdersCard.renewed", { id: o.order_id }));
      // The balance, the plans (and the Proxy balance card on Profiles) and this list read again.
      void refreshAfterPurchase();
    } catch (e) { toast.fail({ title: t("psOrdersCard.renewFailed", { id: o.order_id }), detail: e }); }
    finally { setB(o.order_id, false); }
  };

  const go = (next: boolean) => {
    const off = Math.max(0, offset + (next ? PS_ORDERS_PAGE : -PS_ORDERS_PAGE));
    setOffset(off);
    load(off);
  };

  // Orders here are Datacenter/ISP only: residential is managed in the
  // Residential card, mobile isn't manageable from the launcher.
  const visible = useMemo(() => orders.filter((o) => isDcIsp(o.product_name)), [orders]);
  const list = useListLayout({
    storageKey: "shardx.psOrders.layout",
    defs: ORDER_COLUMNS,
    items: visible,
    selectable: false,
    tail: status === "on-hold" ? ACTIONS_TRACK_ON_HOLD : ACTIONS_TRACK,
    actionsLabel: t("profileTable.colActions"),
  });
  // An empty list has no header controls, only its centered state (owner);
  // a status with none offers Show all there.
  const empty = !loading && !error && visible.length === 0;
  // The status as a word in "No … orders".
  const statusWord: Record<string, string> = {
    active: t("psStates.wordActive"), "on-hold": t("psStates.wordOnHold"), cancelled: t("psStates.wordCancelled"),
  };

  return (
    <section data-ps-card="orders" className="flex flex-col gap-2">
      <div className="flex min-h-[30px] items-center justify-between gap-3">
        <h2 className="m-0 text-section-title text-text-strong-950">{t("psOrdersCard.title")}</h2>
        {!empty && (
          <div className="flex items-center gap-2">
            <div className="w-[130px]">
              <Select
                size="xsmall"
                aria-label={t("psOrdersCard.statusLabel")}
                value={status}
                onChange={setStatus}
                options={[
                  { value: "active", label: t("psOrdersCard.statusActive") },
                  { value: "on-hold", label: t("psOrdersCard.statusOnHold") },
                  { value: "cancelled", label: t("psOrdersCard.statusCancelled") },
                  { value: "all", label: t("psOrdersCard.statusAll") },
                ]}
              />
            </div>
            <IconButton variant="neutral" mode="stroke" size="2xsmall" onClick={() => load()} icon={<RefreshIcon className="size-3.5" />} label={t("psOrdersCard.refreshTitle")} />
          </div>
        )}
      </div>
      <DataList<PsOrder>
        aria-label={t("psOrdersCard.title")}
        items={list.items}
        columns={list.columns}
        layout={list.layout}
        getId={(o) => String(o.order_id)}
        getName={(o) => o.product_name}
        labels={{ selectAll: t("dataList.selectAll"), select: (name) => t("dataList.select", { name }), more: t("pageHeader.more"), actions: t("profileTable.colActions") }}
        status={loading ? "loading" : error ? "error" : "ready"}
        loading={<LoadingRows rows={3} rowHeight={36} inGrid />}
        error={<LoadError what={t("psStates.orders")} error={error ?? ""} onRetry={() => void load()} headingLevel={3} />}
        empty={
          <div className="flex items-center gap-2 py-6">
            <p className="m-0 text-secondary text-text-soft-400">
              {status === "all" ? t("psStates.noOrders") : t("psStates.noStatusOrders", { status: statusWord[status] ?? status })}
            </p>
            {status !== "all" && <Button variant="neutral" mode="ghost" size="3xsmall" onClick={() => setStatus("all")}>{t("psStates.showAll")}</Button>}
          </div>
        }
        onOpen={(o) => setImporting(o)}
        rowActions={(o) => (
          <>
            <Button variant="neutral" mode="ghost" size="3xsmall" leftIcon={<DownloadIcon className="size-3.5" />} onClick={() => setImporting(o)}>
              {t("psOrdersCard.importButton")}
            </Button>
            {status === "on-hold" && (
              <Button variant="neutral" mode="ghost" size="3xsmall" disabled={busy[o.order_id]} onClick={() => void renew(o)}>{t("psOrdersCard.renew")}</Button>
            )}
          </>
        )}
        menuItems={(o) => [
          { label: t("psOrdersCard.importButton"), icon: <DownloadIcon className="size-3.5" />, onSelect: () => setImporting(o) },
          { label: t("psOrdersCard.editTagTitle"), icon: <EditIcon className="size-3.5" />, onSelect: () => setTagging(o) },
          ...(status === "on-hold" ? [{ label: t("psOrdersCard.renew"), onSelect: () => void renew(o) }] : []),
        ]}
      />
      {/* Only over rows: never under an error or while loading (PC-126). */}
      {!loading && !error && (offset > 0 || hasNext) && (
        <div className="mt-1 flex items-center justify-center gap-3.5">
          <Button variant="neutral" mode="stroke" size="3xsmall" disabled={offset <= 0} onClick={() => go(false)}>{t("psOrdersCard.prev")}</Button>
          <span className="text-secondary tabular-nums text-text-soft-400">{t("psOrdersCard.page", { n: Math.floor(offset / PS_ORDERS_PAGE) + 1 })}</span>
          <Button variant="neutral" mode="stroke" size="3xsmall" disabled={!hasNext} onClick={() => go(true)}>{t("psOrdersCard.next")}</Button>
        </div>
      )}
      {importLife.mounted && importShown && (
        <PsImportModal key={importLife.session} open={importing != null} order={importShown} onClose={() => setImporting(null)} />
      )}
      {tagLife.mounted && tagShown && (
        <PsTagModal key={tagLife.session} open={tagging != null} order={tagShown} onClose={() => setTagging(null)} onDone={() => { setTagging(null); load(); }} />
      )}
    </section>
  );
}
