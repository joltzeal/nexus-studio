import type { ReactNode } from "react";
import { NewProxyButton, ProxiesMoreMenu, ProxyDisplayMenu, ProxyFilterBar } from "../../features/manage-proxies";

export function ProxyToolbarLayout({ children }: { children: ReactNode }) {
  return <div className="flex items-center flex-none gap-2">{children}</div>;
}

/// Filters and Display act on rows; with none they are noise (LAYOUT-20).
/// Then one `…` menu and one filled primary (F4).
export function ProxyToolbar({ empty = false }: { empty?: boolean }) {
  return (
    <ProxyToolbarLayout>
      {!empty && <ProxyFilterBar />}
      {!empty && <ProxyDisplayMenu />}
      <ProxiesMoreMenu />
      <NewProxyButton />
    </ProxyToolbarLayout>
  );
}
