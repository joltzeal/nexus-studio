import { useEffect, useState } from "react";
import {
  helperFields, helperFill, helperClose, helperDismiss, type HelperField,
} from "../../entities/profile/model/api";
import { Button, IconButton } from "@proxyshard/shardx-ui-kit";
import { CloseIcon } from "../../shared/icons";
import { FloatingPanel } from "../../shared/ui/FloatingPanel";
import { useT } from "../../shared/i18n";
import { hasOwn } from "../../shared/lib/utils";
import { useAutomationEffectScope } from "../../entities/automation/lib/scope";

export type HelperPanelApi = {
  fields: typeof helperFields;
  fill: typeof helperFill;
  close: typeof helperClose;
  dismiss: typeof helperDismiss;
};
const upstreamHelperApi: HelperPanelApi = { fields: helperFields, fill: helperFill, close: helperClose, dismiss: helperDismiss };

/**
 * Shard Helper: offers to fill a form the browser noticed. It only ever offers —
 * nothing is typed until the button is pressed — and closes itself once the page
 * has nothing left to fill.
 */
export function HelperPanel({ profile, api = upstreamHelperApi }: { profile: string; api?: HelperPanelApi }) {
  const t = useT();
  const [fields, setFields] = useState<HelperField[]>([]);
  const [busy, setBusy] = useState(false);
  const [filled, setFilled] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const captureScope = useAutomationEffectScope(profile);

  useEffect(() => {
    let alive = true;
    const scope = captureScope();
    let last = "";
    const tick = async () => {
      try {
        const r = await api.fields(profile);
        if (!alive || !scope.current()) return;
        setError(null);
        const next = r?.fields ?? [];
        // Unchanged: nothing to draw (PERF-23).
        const json = JSON.stringify(next);
        if (json !== last) { last = json; setFields(next); }
        // Nothing left to fill — the page moved on, or the browser closed.
        if (next.length === 0) void api.close();
      } catch (cause) {
        if (!alive || !scope.current()) return;
        if (api === upstreamHelperApi) void api.close();
        else setError(String(cause instanceof Error ? cause.message : cause));
      }
    };
    void tick();
    const id = setInterval(tick, 1200);
    return () => { alive = false; clearInterval(id); };
  }, [profile, api, captureScope]);

  /** What a kind is called to a person. */
  const LABELS: Record<string, string> = {
    first_name: t("helperPanel.firstName"), last_name: t("helperPanel.lastName"),
    full_name: t("helperPanel.fullName"),
    email: t("helperPanel.email"), username: t("helperPanel.username"),
    phone: t("helperPanel.phone"), country: t("helperPanel.country"), city: t("helperPanel.city"),
    postal_code: t("helperPanel.postcode"), street: t("helperPanel.address"),
    birth_day: t("helperPanel.birthDay"), birth_month: t("helperPanel.birthMonth"),
    birth_year: t("helperPanel.birthYear"),
    birth_date: t("helperPanel.birthDate"), gender: t("helperPanel.gender"),
  };

  const kinds = [...new Set(fields.map((f) => f.kind))];

  return (
    <FloatingPanel
      title={t("helperPanel.title")}
      actions={
        <IconButton
          size="3xsmall"
          icon={<CloseIcon className="size-3.5" />}
          label={t("helperPanel.dismiss")}
          tooltipSide="bottom"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            const scope = captureScope();
            void api.dismiss(profile).catch((cause) => { if (scope.current()) setError(String(cause)); });
          }}
        />
      }
    >

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-1">
        {error && <p role="alert" className="m-0 text-secondary text-error-text">{error}</p>}
        {/* In a group each window fills with its own person. */}
        <div className="flex flex-wrap gap-1">
          {kinds.map((k) => (
            <span key={k}
                  className="rounded-chip px-1.5 py-0.5 text-secondary text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
              {hasOwn(LABELS, k) ? LABELS[k] : k}
            </span>
          ))}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-3 pt-1">
        <Button
          size="2xsmall"
          className="w-full"
          onMouseDown={(e) => e.stopPropagation()}
          disabled={busy || fields.length === 0}
          onClick={async () => {
            const scope = captureScope();
            setBusy(true);
            try {
              const count = await api.fill(profile);
              if (scope.current()) setFilled(count);
            } catch (cause) {
              if (scope.current()) setError(String(cause instanceof Error ? cause.message : cause));
            }
            finally { if (scope.current()) setBusy(false); }
          }}
        >
          {filled > 1
            ? t("helperPanel.filledWindows", { n: filled })
            : filled === 1
              ? t("helperPanel.fillAgain")
              : fields.length === 1
                ? t("helperPanel.fillOneField")
                : t("helperPanel.fillFields", { n: fields.length })}
        </Button>
      </div>
    </FloatingPanel>
  );
}
