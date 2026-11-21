import { useId, useState } from "react";
import { Button, Switch } from "@proxyshard/shardx-ui-kit";
import { useT } from "../../../shared/i18n";
import { SettingRow, SettingsGroup, type SettingsProps } from "../SettingRow";

/// Settings that belong to no page of their own. Usage statistics sat under
/// General, between the language and the tray, where a setting about what
/// leaves this computer read as one more preference (owner, 2026-10-22).
export function OtherSection({ p, setP }: SettingsProps) {
  const t = useT();
  const detailsId = useId();
  const [details, setDetails] = useState(false);
  return (
    <SettingsGroup>
      {/* Kept in this window's storage, changed on Save (backend list, Task 38).
          One line of help, as every row has; what is sent, word for word,
          behind Learn more (MP4 review, M10). */}
      <SettingRow
        id="analytics"
        title={t("settings.analyticsLabel")}
        help={
          <>
            {t("settings.analyticsHelp")}{" "}
            <Button
              mode="link"
              variant="primary"
              size="3xsmall"
              // In the help's own face, underlined as the API row's link is.
              className="text-help underline"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails((v) => !v)}
            >
              {details ? t("settings.analyticsLess") : t("settings.analyticsMore")}
            </Button>
          </>
        }
        control={({ labelId, helpId }) => (
          <Switch aria-labelledby={labelId} aria-describedby={helpId} checked={p.analytics} onChange={(on) => setP("analytics", on)} />
        )}
        below={details ? <p id={detailsId} className="m-0 text-pretty text-help measure text-text-sub-600">{t("settings.analyticsDetails")}</p> : undefined}
      />
    </SettingsGroup>
  );
}
