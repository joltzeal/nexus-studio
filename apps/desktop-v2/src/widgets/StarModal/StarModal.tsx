import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Modal } from "@proxyshard/shardx-ui-kit";
import { GithubMark, StarOutlineIcon } from "../../shared/icons";
import { GH_REPO_URL } from "../../shared/lib/utils";
import { useT } from "../../shared/i18n";
import { useStarAsk } from "../../features/star-ask";

/// The GitHub-star ask, once the app has been used for real (EMIL-19): after
/// the 10th confirmed Start on 2 or more days, never on a first run.
/// "Maybe later" (and Esc) asks again in 30 days; Star or "Don't ask again"
/// ends it (useStarAsk).
export function StarModal() {
  const t = useT();
  const ask = useStarAsk();
  const star = () => {
    openUrl(GH_REPO_URL).catch(() => {});
    ask.done();
  };
  return (
    <Modal open={ask.show} onClose={ask.later} size="sm" aria-label={t("starModal.title")} closeLabel={t("common.close")}>
      <div className="px-2 pb-2 pt-4 text-center">
        <div className="relative mx-auto mb-4 flex size-[58px] items-center justify-center rounded-full bg-bg-weak-50 text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
          <GithubMark size={26} />
          {/* A drawn star, filled like the ★ it replaces, not a glyph at an off-scale size. */}
          <StarOutlineIcon aria-hidden fill="currentColor" className="absolute -top-[5px] right-[-3px] size-3.5 text-[var(--label-yellow)]" />
        </div>
        <h2 className="m-0 mb-2 text-balance text-panel-title text-text-strong-950">{t("starModal.title")}</h2>
        <p className="m-0 mb-[22px] text-balance text-body text-text-sub-600">
          {t.rich("starModal.blurb", { b: (s) => <strong>{s}</strong> })}
        </p>
        <div className="flex justify-center gap-2.5">
          <Button variant="neutral" mode="stroke" size="xsmall" onClick={ask.later}>
            {t("starModal.later")}
          </Button>
          <Button variant="primary" mode="filled" size="xsmall" leftIcon={<GithubMark />} onClick={star}>
            {t("starModal.starButton")}
          </Button>
        </div>
        {/* The quiet way out, under the two: a 400 px dialog has no room for three in a row. */}
        <div className="mt-2 flex justify-center">
          <Button variant="neutral" mode="ghost" size="xsmall" onClick={ask.done}>
            {t("starModal.never")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
