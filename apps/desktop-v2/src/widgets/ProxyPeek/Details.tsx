import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconButton } from "@proxyshard/shardx-ui-kit";
import { EyeIcon, EyeOffIcon } from "../../shared/icons";
import { CountryFlag } from "../../shared/ui/CountryFlag";
import { SelectField } from "../../shared/ui/SelectField";
import { PropertyRow, PropertySheet, PropertyValue } from "../../shared/ui/peek";
import { toast } from "../../shared/model/toast";
import { useT } from "../../shared/i18n";
import type { ProxyEntry } from "../../entities/proxy";
import { PS_SIGNATURES, psActive, psSignatureSet } from "../../entities/proxyshard";
import { isNativeRaccoon } from "../../raccoon/runtime";

const KIND = { socks5: "SOCKS5", http: "HTTP", https: "HTTPS" } as const;

/// A proxy's details, read: label and value rows, as the profile panel's.
/// Nothing here changes the proxy; Edit in the header opens the dialog where
/// it is changed and saved by hand. The password is dots until the eye shows
/// it (and then it is on the screen, not just in the page).
export function Details({ proxy: p }: { proxy: ProxyEntry }) {
  const t = useT();
  return (
    <ProxyConnectionDetails
      protocol={KIND[p.kind]}
      host={p.host}
      port={p.port}
      username={p.username}
      hasPassword={!!p.password}
      password={p.password}
      country={p.country}
      extra={<ProxyDetailRow id="notes" label={t("proxyPeek.notes")} value={p.notes || t("peek.noNotes")} empty={!p.notes} wrap selectable={!!p.notes} />}
      footer={!isNativeRaccoon() && <Signature proxy={p} />}
    />
  );
}

export function ProxyDetailRow({ id, label, value, empty, wrap, mono, selectable }: {
  id: string;
  label: string;
  value: ReactNode;
  empty?: boolean;
  wrap?: boolean;
  mono?: boolean;
  selectable?: boolean;
}) {
  return (
    <PropertyRow id={id} label={label}>
      {() => (
        <PropertyValue empty={empty} wrap={wrap}>
          <span data-selectable={selectable ? "" : undefined} className={mono ? "mono min-w-0 truncate" : wrap ? "min-w-0 whitespace-pre-wrap break-words" : "min-w-0 truncate"}>{value}</span>
        </PropertyValue>
      )}
    </PropertyRow>
  );
}

export function ProxyConnectionDetails({ protocol, host, port, username, country, hasPassword, password, extra, footer }: {
  protocol: ReactNode;
  host: string;
  port: number;
  username: string;
  country: string | null;
  hasPassword: boolean;
  password?: string;
  extra?: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const none = t("proxyPeek.none");
  return (
    <PropertySheet>
      <div className="flex flex-col gap-[2px]">
        <ProxyDetailRow id="type" label={t("proxyEditor.typeLabel")} value={protocol} />
        <ProxyDetailRow id="host" label={t("proxyEditor.hostLabel")} value={host} mono selectable />
        <ProxyDetailRow id="port" label={t("proxyEditor.portLabel")} value={port} mono selectable />
        <ProxyDetailRow id="username" label={t("proxyEditor.usernameLabel")} value={username || none} empty={!username} selectable={!!username} wrap />
        <PropertyRow id="password" label={t("proxyEditor.passwordLabel")}>
          {() => (
            <>
              <PropertyValue empty={!hasPassword}>
                {!hasPassword ? <span className="truncate">{none}</span>
                  : shown && password ? <span data-selectable className="mono min-w-0 truncate">{password}</span>
                  : !password ? <span className="min-w-0 truncate">••••••••</span>
                  : <span aria-hidden="true" className="min-w-0 truncate">••••••••</span>}
              </PropertyValue>
              {password && (
                // One name, "Show password"; whether it is shown is `aria-pressed` (PC-073).
                <IconButton
                  size="3xsmall"
                  label={t("proxyPeek.showPassword")}
                  aria-pressed={shown}
                  icon={shown ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                  onClick={() => setShown((v) => !v)}
                />
              )}
            </>
          )}
        </PropertyRow>
        <PropertyRow id="country" label={t("proxyEditor.countryLabel")}>
          {() => (
            <PropertyValue empty={!country}>
              {country ? (
                <>
                  <CountryFlag cc={country} height={14} />
                  <span className="truncate">{country}</span>
                </>
              ) : <span className="truncate">{none}</span>}
            </PropertyValue>
          )}
        </PropertyRow>
        {extra}
      </div>
      {footer}
    </PropertySheet>
  );
}

/// A proxy from a ProxyShard DC/ISP order (its notes carry the order id) can
/// change the p0f OS signature of its IP. It applies at once, as a command
/// does: it changes the order at ProxyShard, not this proxy's saved fields.
function Signature({ proxy }: { proxy: ProxyEntry }) {
  const t = useT();
  const orderId = useMemo(() => {
    const m = proxy.notes.match(/ProxyShard (?:order|订单) (\d+)/);
    return m ? Number(m[1]) : null;
  }, [proxy.notes]);
  const [current, setCurrent] = useState("");
  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    psActive(orderId)
      .then((r) => { if (alive) setCurrent((r.data ?? []).find((d: { ip: string }) => d.ip === proxy.host)?.signature ?? ""); })
      .catch(() => {});
    return () => { alive = false; };
  }, [orderId, proxy.host]);
  if (!orderId) return null;
  return (
    <div className="mt-stack-md">
      <SelectField
        label={t("proxyEditor.signatureLabel", { n: orderId })}
        value={current}
        placeholder={t("proxyEditor.signatureKeep")}
        options={PS_SIGNATURES}
        onChange={(sig) => {
          if (!sig || sig === current) return;
          psSignatureSet(orderId, [{ ip: proxy.host, signature: sig }])
            .then(() => { setCurrent(sig); toast.ok(t("proxyEditor.p0fSet", { sig })); })
            .catch((e) => toast.fail({ title: t("proxyEditor.p0fFailed"), detail: e }));
        }}
      />
    </div>
  );
}
