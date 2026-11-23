import type { ReactNode } from "react";
import { Button, Label } from "@proxyshard/shardx-ui-kit";
import { BuildingIcon, ClockIcon, GlobeIcon } from "../../shared/icons";
import { CountryFlag } from "../../shared/ui/CountryFlag";
import { fmtTs } from "../../shared/lib/utils";
import { useT } from "../../shared/i18n";

export type ProxyHistoryItem = {
  ip: string;
  countryCode: string | null;
  city: string | null;
  firstSeen: string;
  lastSeen: string;
};

export function ProxyIpHistory({ items }: { items: readonly ProxyHistoryItem[] }) {
  const t = useT();
  return (
    <>
      <Label as="div" className="mt-1">{t("proxyPeek.history")}</Label>
      {items.length === 0 ? (
        <p className="m-0 text-secondary text-text-soft-400">{t("proxyInfoPopover.historyEmpty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((item, index) => (
            <li key={`${item.ip}-${item.firstSeen}-${index}`} data-history-item data-selectable className="py-2">
              <div className="flex items-center gap-2 text-body text-text-strong-950">
                <span className="mono">{item.ip || "—"}</span>
                {item.countryCode && <CountryFlag cc={item.countryCode} />}
                {item.city && <span className="text-secondary text-text-soft-400">{item.city}</span>}
              </div>
              <div className="mt-0.5 text-secondary text-text-soft-400">
                {item.firstSeen === item.lastSeen
                  ? fmtTs(item.firstSeen)
                  : t("proxyPeek.historySpan", { from: fmtTs(item.firstSeen), to: fmtTs(item.lastSeen) })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ProxyInspectionResult({ ip, place, countryCode, timezone, isp, checkedAt, status, error }: {
  ip?: string | null;
  place?: string | null;
  countryCode?: string | null;
  timezone?: string;
  isp?: string | null;
  checkedAt: string;
  status: ReactNode;
  error?: ReactNode;
}) {
  return (
    <div data-test-result className="flex flex-col gap-[14px] text-ui text-text-strong-950">
      {ip && <Fact icon={<GlobeIcon className="size-3.5" />}><span className="mono">{ip}</span></Fact>}
      {place && <Fact icon={countryCode ? <CountryFlag cc={countryCode} height={14} /> : <GlobeIcon className="size-3.5" />}>{place}</Fact>}
      {timezone && <Fact icon={<ClockIcon className="size-3.5" />}>{timezone}</Fact>}
      {isp && <Fact icon={<BuildingIcon className="size-3.5" />}>{isp}</Fact>}
      <div className="flex flex-wrap items-center gap-2">
        {status}
        <span className="text-secondary text-text-soft-400">{fmtTs(checkedAt)}</span>
      </div>
      {error}
    </div>
  );
}

export function ProxyProfiles({ profiles, onSelect }: {
  profiles: readonly { id: string; name: string; followsDefault?: boolean }[] | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  if (profiles === null) return <p className="m-0 text-secondary text-text-soft-400">Profile 占用暂不可用</p>;
  if (profiles.length === 0) return <p className="m-0 text-secondary text-text-soft-400">{t("proxyPeek.noProfiles")}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {profiles.map((profile) => (
        <li key={profile.id}>
          <Button variant="neutral" mode="ghost" size="3xsmall" onClick={() => onSelect(profile.id)}>
            {profile.name}
            {profile.followsDefault && <span className="text-text-soft-400">跟随默认</span>}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="inline-grid w-3.5 place-items-center text-icon-soft-400">{icon}</span>
      <span data-selectable className="min-w-0">{children}</span>
    </div>
  );
}
