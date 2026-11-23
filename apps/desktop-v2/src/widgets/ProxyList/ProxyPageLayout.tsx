import type { ReactNode } from "react";
import { ListColumn } from "../../shared/ui/ListColumn";
import { PageBody } from "../PageHeader";

export function ProxyPageLayout({ filters, notice, list, footer, peek }: {
  filters?: ReactNode;
  notice?: ReactNode;
  list: ReactNode;
  footer?: ReactNode;
  peek: ReactNode;
}) {
  return (
    <PageBody scroll={false} className="relative">
      {filters}
      {notice}
      <div className="relative flex min-h-0 flex-1 gap-panel">
        {footer ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ListColumn>{list}</ListColumn>
            {footer}
          </div>
        ) : <ListColumn>{list}</ListColumn>}
        {peek}
      </div>
    </PageBody>
  );
}
