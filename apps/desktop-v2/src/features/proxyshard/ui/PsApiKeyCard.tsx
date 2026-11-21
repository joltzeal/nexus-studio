import { useEffect, useState } from "react";
import { Button, Card, DialogModal, IconButton, Input } from "@proxyshard/shardx-ui-kit";
import { EyeIcon, EyeOffIcon, KeyIcon } from "../../../shared/icons";
import { useT } from "../../../shared/i18n";
import { PsConnectionBadge, usePsAccount } from "../../../entities/proxyshard";

/// The key field, Save, and the check's result under it. One way to try again
/// ("Check again", only after a failure and while the field holds the saved
/// key), one place for the reason (PC-127).
export function PsApiKeyForm({ autoFocus }: { autoFocus?: boolean }) {
  const t = useT();
  const key = usePsAccount((s) => s.key);
  const status = usePsAccount((s) => s.status);
  const me = usePsAccount((s) => s.me);
  const err = usePsAccount((s) => s.err);
  const saveKey = usePsAccount((s) => s.saveKey);
  const refreshMe = usePsAccount((s) => s.refreshMe);
  const [draft, setDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  // The field follows the saved key once it loads from disk.
  useEffect(() => { setDraft(key ?? ""); }, [key]);
  const changed = draft.trim() !== (key ?? "");

  return (
    <div data-ps-key-state={status} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            inputSize="xsmall"
            aria-label={t("psApiKeyCard.hintApiKey")}
            secret
            autoFocus={autoFocus}
            type={showKey ? "text" : "password"}
            leftIcon={<KeyIcon className="size-3.5" />}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && changed) void saveKey(draft); }}
            rightIcon={
              <IconButton
                size="3xsmall"
                className="pointer-events-auto"
                icon={showKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                label={showKey ? t("psApiKeyCard.hideKeyTitle") : t("psApiKeyCard.showKeyTitle")}
                onClick={() => setShowKey((v) => !v)}
              />
            }
          />
        </div>
        {status === "err" && !changed ? (
          <Button variant="neutral" mode="stroke" size="xsmall" onClick={() => void refreshMe()}>{t("psStates.checkAgain")}</Button>
        ) : (
          <Button variant="primary" mode="filled" size="xsmall" disabled={!changed} isLoading={status === "checking"} onClick={() => void saveKey(draft)}>
            {t("psApiKeyCard.saveButton")}
          </Button>
        )}
      </div>
      <PsConnectionBadge status={status} me={me} err={err} hasKey={!!key} />
    </div>
  );
}

/// The page while no key works: this card is all there is (craft target).
/// A wide card sets the form beside its words, so the key field stays a key's length.
export function PsKeySetup() {
  const t = useT();
  return (
    <Card data-ps-key-setup padding="sm" className="@container/setup">
      <div className="flex flex-col gap-3 @min-[1100px]/setup:grid @min-[1100px]/setup:grid-cols-[minmax(0,1fr)_minmax(0,640px)] @min-[1100px]/setup:items-start @min-[1100px]/setup:gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-section-title text-text-strong-950">{t("psKey.setupTitle")}</h2>
          <p className="m-0 max-w-[72ch] text-help text-text-sub-600">{t("psKey.setupHelp")}</p>
        </div>
        <PsApiKeyForm />
      </div>
    </Card>
  );
}

/// "Change API key…" from the header menu while connected. It closes with
/// Esc or its close button; a key saved here shows its check here.
export function PsKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <DialogModal open={open} onClose={onClose} size="sm" title={t("psKey.changeTitle")} hideFooter>
      <div className="flex flex-col gap-2 py-4">
        <p className="m-0 text-help text-text-sub-600">{t("psKey.setupHelp")}</p>
        <PsApiKeyForm autoFocus />
      </div>
    </DialogModal>
  );
}
