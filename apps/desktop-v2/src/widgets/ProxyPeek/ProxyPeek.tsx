import { useEffect, useRef, useState } from "react";
import { Badge, Button, Tooltip, usePresence, useLatched } from "@proxyshard/shardx-ui-kit";
import { EditIcon, RefreshIcon } from "../../shared/icons";
import { ProxyTestPill } from "../../shared/ui/StatusPill";
import { PeekBody, PeekHeader, PeekPanel, PeekSection } from "../../shared/ui/peek";
import { explainError } from "../../shared/lib/errors";
import { focusProxyRow } from "../../shared/lib/focusRow";
import { useT } from "../../shared/i18n";
import { proxyHistory, proxyStatus, useProxy, type ProxyEntry, type ProxyTestSnapshot } from "../../entities/proxy";
import { useProfileUi } from "../../entities/profile";
import { onProxy, teamRefusal, useRightsChange } from "../../entities/space";
import { capOf, command, menuItemsFor } from "../../features/commands";
import { EditProxyDialog } from "../../features/manage-proxies";
import { Details } from "./Details";
import { ProxyInspectionResult, ProxyIpHistory, ProxyProfiles } from "./Inspection";
import { toast } from "../../shared/model/toast";
import { isNativeRaccoon } from "../../raccoon/runtime";
import { proxyUsage } from "../../raccoon/proxy-adapter";
import { workspace } from "../../raccoon/store";
import { useNav } from "../../shared/model/navigation";

/// The side panel that shows and tests one proxy while the list stays in
/// view, as Profile Peek does for a profile. It only shows: Edit in the
/// header opens the dialog, where a change is saved by hand. The shell
/// (frame, header, sections, the way in and out) is every Peek's (F1).
export function ProxyPeek() {
  const t = useT();
  const peekId = useProxy((s) => s.peekId);
  const closePeek = useProxy((s) => s.closePeek);
  const proxy = useProxy((s) => (peekId ? s.proxies.find((p) => p.id === peekId) : undefined));
  /** The proxy the Edit dialog is open on. */
  const [editing, setEditing] = useState<string | null>(null);

  // The proxy left the list (deleted): Peek goes with it.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    if (proxy) shownId.current = proxy.id;
    else if (peekId && shownId.current === peekId) closePeek();
  }, [peekId, proxy, closePeek]);

  // Kept through the exit: the panel leaves showing what it showed (FEEL-02).
  const open = peekId && proxy ? proxy : null;
  const presence = usePresence(open?.id ?? null, { maxExitMs: 250 });
  const p = useLatched(open);
  if (!presence.mounted || !p) return null;
  const name = p.name || `${p.host}:${p.port}`;
  const close = () => {
    // From inside Peek (its Close), the keyboard goes back to the row: the
    // panel is inert while it leaves.
    const inside = document.activeElement?.closest("aside[data-peek]") != null;
    closePeek();
    focusProxyRow(p.id, { ifLost: !inside });
  };

  return (
    <>
      <PeekPanel kind="proxy" label={t("proxyPeek.label", { name })} presence={presence}>
        <ProxyPeekHeader name={name} proxy={p} onEdit={() => setEditing(p.id)} onClose={close} />
        <PeekBody>
          <PeekSection id="details" title={t("proxyPeek.details")}>
            {/* Keyed by the proxy: Peek never unmounts while the arrows move it,
                and a password shown for one never shows for the next. */}
            <Details key={p.id} proxy={p} />
          </PeekSection>
          <PeekSection key={p.id} id="test" title={t("proxyPeek.test")}>
            <TestSection proxy={p} />
          </PeekSection>
          <PeekSection id="profiles" title={t("proxyPeek.profiles")}>
            <ProfilesUsing proxyId={p.id} />
          </PeekSection>
        </PeekBody>
      </PeekPanel>
      <EditProxyDialog id={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function ProxyPeekHeader({ name, proxy, onEdit, onClose }: {
  name: string;
  proxy: ProxyEntry;
  onEdit: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const snap = useProxy((s) => s.snapshots[proxy.id]);
  const busy = useProxy((s) => !!s.proxyTesting[proxy.id]);
  const testProxy = useProxy((s) => s.testProxy);
  const testStatus = proxyStatus(snap);
  // The registry's Peek menu (E3, R9): Copy address and Delete…, as the
  // row menu has them. Test is the header's own Test now.
  const menuItems = menuItemsFor("peekMenu", "proxies", { ids: [proxy.id] });
  // A team's proxy without Edit for this person: Edit says why and does nothing.
  useRightsChange();
  const noEdit = teamRefusal("edit", onProxy(proxy.id));
  return (
    <PeekHeader
      subject={proxy.id}
      title={<h2 className="m-0 min-w-0 truncate text-panel-title text-text-strong-950">{name}</h2>}
      // The Live layer's test pill (spec 4.2). The Proxies row still draws a
      // dot and a word until the pair that rebuilds that list adopts it.
      status={
        testStatus === "ok"
          ? <ProxyTestPill data-peek-test-status state="ok" ms={snap!.tcp_ms!} busy={busy} />
          : <ProxyTestPill data-peek-test-status state={testStatus} busy={busy} />
      }
      extra={
        <Tooltip content={noEdit ?? undefined}>
          <Button
            variant="neutral" mode="stroke" size="3xsmall" data-peek-edit leftIcon={<EditIcon className="size-3.5" />}
            disabled={!!noEdit} aria-description={noEdit ?? undefined}
            onClick={onEdit}
          >
            {t("peek.edit")}
          </Button>
        </Tooltip>
      }
      primary={
        // The test runs on the proxy as it is saved.
        <Button
          variant="primary" mode="lighter" size="3xsmall" leftIcon={<RefreshIcon className="size-3.5" />}
          isLoading={busy}
          onClick={() => void testProxy(proxy)}
        >
          {t("proxyPeek.testNow")}
        </Button>
      }
      menuItems={menuItems}
      menuLabel={t("pageHeader.more")}
      closeLabel={t("peek.close")}
      closeShortcut={capOf(command("proxy.closePeek"))}
      onClose={onClose}
    />
  );
}

/// The last test's result and the IP history; "Test now" is the header's
/// main action (LAYOUT-12).
function TestSection({ proxy }: { proxy: ProxyEntry }) {
  const t = useT();
  const snap = useProxy((s) => s.snapshots[proxy.id]);
  const busy = useProxy((s) => !!s.proxyTesting[proxy.id]);
  const [history, setHistory] = useState<ProxyTestSnapshot[]>([]);
  // Newest first; read again after each test of this proxy.
  useEffect(() => {
    let alive = true;
    proxyHistory(proxy.id).then((h) => { if (alive) setHistory([...h].reverse()); }).catch(() => {});
    return () => { alive = false; };
  }, [proxy.id, snap, busy]);

  return (
    <>
      {snap ? <Result proxy={proxy} snap={snap} /> : <p className="m-0 text-secondary text-text-soft-400">{t("proxyPeek.notTested")}</p>}
      <ProxyIpHistory items={history.map((observation) => ({
        ip: observation.ip,
        countryCode: observation.country_code,
        city: observation.city,
        firstSeen: observation.first_seen,
        lastSeen: observation.last_seen,
      }))} />
    </>
  );
}

function Result({ proxy, snap }: { proxy: ProxyEntry; snap: ProxyTestSnapshot }) {
  const t = useT();
  const status = proxyStatus(snap);
  const place = [snap.region, snap.city].filter(Boolean).join(", ") || snap.country;
  return (
    <ProxyInspectionResult
      ip={snap.ip}
      place={place}
      countryCode={snap.country_code}
      timezone={snap.timezone}
      isp={snap.isp}
      checkedAt={snap.last_seen}
      status={
        <>
          <Badge color={status === "ok" ? "success" : "error"} size="small">
            {snap.tcp_ms != null ? t("proxyPeek.tcpOk", { ms: snap.tcp_ms }) : t("proxyPeek.tcpFailed")}
          </Badge>
          {proxy.kind === "socks5" && !isNativeRaccoon() && (
            <Tooltip content={snap.udp_error ?? ""}>
              <Badge color={snap.udp_ms != null ? "success" : "error"} size="small">
                {snap.udp_ms != null ? t("proxyPeek.udpOk", { ms: snap.udp_ms }) : t("proxyPeek.udpFailed")}
              </Badge>
            </Tooltip>
          )}
        </>
      }
      error={snap.geo_error && (
        <p className="m-0 text-secondary text-error-text">
          {t("proxyInfoPopover.geoError")}
          <span className="block text-secondary text-text-soft-400" data-selectable>{explainError(snap.geo_error)}</span>
        </p>
      )}
    />
  );
}

function ProfilesUsing({ proxyId }: { proxyId: string }) {
  const profiles = useProxy((s) => s.profiles);
  const using = profiles.filter((p) => p.proxy_id === proxyId);
  return (
    <ProxyProfiles profiles={using} onSelect={(id) => {
      if (!isNativeRaccoon()) { void useProfileUi.getState().showInList(id); return; }
      const usage = proxyUsage().find((item) => item.id === id);
      if (!usage) return;
      void workspace.select(usage.connectionId).then(async () => {
        await useNav.getState().setSection("profiles");
        await useProfileUi.getState().showInList(id);
      }).catch((error) => toast.fail({ title: "Profile 加载失败", detail: error }));
    }} />
  );
}
