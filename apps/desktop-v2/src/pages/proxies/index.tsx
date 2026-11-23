import { useEffect } from "react";
import { PageHeader } from "../../widgets/PageHeader";
import { useStoreChanged } from "../../shared/hooks/useStoreChanged";
import { useHeldLoading } from "../../shared/hooks/useHeldLoading";
import { countActiveProxyFilters, useFilteredProxies, useProxy } from "../../entities/proxy";
import { storeBus } from "../../shared/lib/storeBus";
import { useDialogLife } from "../../shared/lib/useDialogLife";
import { useNav } from "../../shared/model/navigation";
import { useProfile } from "../../entities/profile";
import { usePsAccount } from "../../entities/proxyshard";
import { useOnboarding } from "../../features/onboarding";
import { ProxyBulkImporter, ProxyFilterChips } from "../../features/manage-proxies";
import { ProxyList } from "../../widgets/ProxyList";
import { ProxyToolbar } from "../../widgets/ProxyList/ProxyToolbar";
import { ProxyPageLayout } from "../../widgets/ProxyList/ProxyPageLayout";
import { ProxyPeek } from "../../widgets/ProxyPeek";
import { ProxyBulkBar } from "../../widgets/ProxyBulkBar";
import { useT } from "../../shared/i18n";
import { showMeAround } from "../../features/tour";
import { isNativeRaccoon } from "../../raccoon/runtime";

export function ProxiesPage() {
  const t = useT();
  const init = useProxy((s) => s.init);
  const reload = useProxy((s) => s.reload);
  const search = useProxy((s) => s.search);
  const setSearch = useProxy((s) => s.setSearch);
  const filterCount = useProxy((s) => countActiveProxyFilters(s.filters));
  const count = useFilteredProxies().length;
  const total = useProxy((s) => s.proxies.length);
  const status = useProxy((s) => s.status);
  const ready = status === "ready";
  const bulkOpen = useProxy((s) => s.bulkOpen);
  const setBulkOpen = useProxy((s) => s.setBulkOpen);
  // It stays mounted through its exit (FEEL-01).
  const bulkLife = useDialogLife(bulkOpen);
  // No proxies at all: nothing to filter or count (LAYOUT-20).
  const empty = ready && total === 0 && !search.trim() && filterCount === 0;
  // The list's placeholder rows wait 150 ms and stay 400 ms (WIG-12); the
  // count waits for them (held here, and passed to the list: one value).
  const loading = useHeldLoading(status === "idle" || status === "loading");

  useEffect(() => { init(); }, [init]);
  // The ProxyShard account, for the page's ProxyShard parts.
  const psInit = usePsAccount((s) => s.init);
  useEffect(() => { if (!isNativeRaccoon()) psInit(); }, [psInit]);
  // Pick up proxies/profiles added via the automation API or MCP live.
  useStoreChanged(reload);

  return (
    <>
      <PageHeader
        title={t("proxies.title")}
        count={!loading && ready && !empty ? (search.trim() || filterCount > 0 ? { shown: count, total } : count) : undefined}
        help={isNativeRaccoon() ? undefined : { title: t("pageHelp.proxies.title"), body: t("pageHelp.proxies.body"), onTour: () => showMeAround("proxies") }}
        filter={empty ? undefined : { value: search, onChange: setSearch }}
        actions={<ProxyToolbar empty={empty} />}
      />
      <ProxyPageLayout
        filters={<ProxyFilterChips />}
        list={
          <>
            <ProxyBulkBar />
            <ProxyList loading={loading} />
          </>
        }
        peek={<ProxyPeek />}
      />
      {bulkLife.mounted && (
        <ProxyBulkImporter
          key={bulkLife.session}
          open={bulkOpen}
          onClose={async (added) => {
            setBulkOpen(false);
            reload();
            // This store has just reloaded: only the Profiles side reads them again.
            storeBus.emit("proxies", "proxies");
            // Opened by step 1 of the setup checklist: back to it once the
            // Profiles side has the new proxy (IFACE-02). No Peek: Proxies
            // would open with it on the next visit.
            if (useOnboarding.getState().endProxyStep()) {
              await useProfile.getState().reload();
              useNav.getState().setSection("profiles");
            } else if (added) {
              // One proxy added from the preview opens in Peek, as New profile does (CRAFT-26).
              useProxy.getState().openPeek(added);
            }
          }}
        />
      )}
    </>
  );
}
