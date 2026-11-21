import { useEffect, useMemo, useState } from "react";
import { Checkbox, type ComboboxOption } from "@proxyshard/shardx-ui-kit";
import { useT } from "../../../shared/i18n";
import { useProfile } from "../../../entities/profile";
import { duplicateLabels, proxyStatus, useProxy } from "../../../entities/proxy";
import { useProxyOptions } from "./ProxySelect";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { ProxyChoiceList, useWorkspaceProxyPool } from "./ProxyChoiceList";
import { poolProxyEndpoint } from "../../../raccoon/profile-proxy";

const NONE: ReadonlySet<string> = new Set();

/// The proxies to hand out (IFACE-03, picker part): a search over the list
/// with checks, "Unused only" to see the proxies no other profile has, and
/// each proxy's last test so an expired one does not look like a working one.
/// Windowed by the Combobox above 100 proxies (it replaces D's WindowedRows).
/// A checked library proxy stays available under the unused filter.
export function SpreadProxyList({ value, onChange, targets = NONE }: {
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  /** The profiles being assigned: their own use of a proxy does not count as used. */
  targets?: ReadonlySet<string>;
}) {
  const t = useT();
  const projected = useProfile((s) => s.proxies);
  const library = useProxy((s) => s.proxies);
  const proxies = isNativeRaccoon() ? library : projected;
  const allowPool = useWorkspaceProxyPool();
  const profiles = useProfile((s) => s.profiles);
  const globalProfiles = useProxy((s) => s.profiles);
  const snapshots = useProxy((s) => s.snapshots);
  // Never share by default (O9b): the proxies another profile uses start hidden.
  const [unusedOnly, setUnusedOnly] = useState(!isNativeRaccoon());
  // The last tests live in the Proxies store; read them if that page was never opened.
  useEffect(() => { void useProxy.getState().loadLastTests(proxies.map((p) => p.id)); }, [proxies]);
  const all = useProxyOptions(proxies);
  const shared = useMemo(() => duplicateLabels(proxies), [proxies]);
  // How many profiles outside this assignment use each proxy.
  const usedOutside = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of isNativeRaccoon() ? globalProfiles : profiles) if (p.proxy_id && !targets.has(p.id)) n.set(p.proxy_id, (n.get(p.proxy_id) ?? 0) + 1);
    if (isNativeRaccoon()) for (const p of profiles) if (p.proxy_id && !targets.has(p.id) && poolProxyEndpoint(p.proxy_id) !== null) n.set(p.proxy_id, (n.get(p.proxy_id) ?? 0) + 1);
    return n;
  }, [profiles, globalProfiles, targets]);
  const options = useMemo(() => {
    const rows: ComboboxOption[] = [];
    for (const o of all) {
      const used = usedOutside.get(o.value) ?? 0;
      if (unusedOnly && used > 0 && !value.has(o.value)) continue;
      const state = proxyStatus(snapshots[o.value]);
      // The test result, and who else uses it; no address before them, which
      // would push them past the row's end on a long host (the search still
      // finds the host).
      const test = state === "ok" ? t("assign.hintWorks") : state === "failed" ? t("proxyTestResult.failed") : t("proxyTestResult.notTested");
      const facts = used > 0 ? `${t("assign.hintUsed", { n: used })}, ${test}` : test;
      // A name another proxy has too keeps its address and country in front
      // (`useProxyOptions`' hint), so the proxies can still be told apart.
      rows.push({ ...o, hint: shared.has(o.label) && o.hint ? `${o.hint}, ${facts}` : facts });
    }
    return rows;
  }, [all, usedOutside, unusedOnly, value, snapshots, shared, t]);
  const unavailableChoices = useMemo(() => unusedOnly
    ? new Set([...usedOutside.keys()].filter((id) => !value.has(id)))
    : undefined, [unusedOnly, usedOutside, value]);
  return (
    <div className="flex flex-col gap-2">
      <Checkbox label={t("assignProxies.unusedOnly")} checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} />
      <div className="tile">
        <ProxyChoiceList
          multiple
          autoFocus={false}
          label={t("assignProxies.spreadLabel")}
          options={options}
          value={[...value]}
          allowPool={allowPool}
          unavailableChoices={unavailableChoices}
          onChange={(id, checked) => {
            const next = new Set(value);
            if (checked) next.add(id); else next.delete(id);
            onChange(next);
          }}
        />
      </div>
      {value.size > 0 && <p className="m-0 text-secondary text-text-sub-600" aria-live="polite">已选 {value.size} 个代理</p>}
    </div>
  );
}
