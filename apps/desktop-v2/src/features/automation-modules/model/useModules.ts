import { useAutomationEffectScope } from "../../../entities/automation/lib/scope";
import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  automationModuleInstall,
  automationModuleRemove,
  automationModules,
  automationModulesDir,
  type ModuleInfo,
} from "../../../entities/automation";
import { useT } from "../../../shared/i18n";
import { toast } from "../../../shared/model/toast";

/// The modules an operator wrote themselves, and the three things done to
/// them: add one, remove one, open their folder. The page header holds the
/// buttons and the list holds the rows, so both read this one hook.
export function useModules() {
  const t = useT();
  const captureScope = useAutomationEffectScope();
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Before the first answer there is nothing to say "no modules" about.
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    const scope = captureScope();
    automationModules().then((value) => { if (scope.current()) setModules(value); })
      .catch((error) => { if (scope.current()) toast.fail({ title: "读取自动化模块失败", detail: error }); })
      .finally(() => { if (scope.current()) setLoaded(true); });
  }, [captureScope]);
  useEffect(() => { reload(); }, [reload]);

  const add = async () => {
    const scope = captureScope();
    try {
      const path = await open({
        title: t("modulesCard.pickerTitle"),
        filters: [{ name: t("modulesCard.pickerFilter"), extensions: ["wasm"] }],
      });
      if (!scope.current() || typeof path !== "string") return;
      setBusy("+");
      const m = await automationModuleInstall(path);
      if (!scope.current()) return;
      reload();
      toast.ok(
        m.blocks.length === 0
          ? t("modulesCard.addedNoSteps", { name: m.name })
          : m.blocks.length === 1
            ? t("modulesCard.addedOneStep", { name: m.name })
            : t("modulesCard.addedSteps", { name: m.name, n: m.blocks.length }),
      );
    } catch (e) {
      if (scope.current()) toast.fail({ title: t("modulesCard.installFailed"), detail: e });
    } finally {
      if (scope.current()) setBusy(null);
    }
  };

  const remove = async (m: ModuleInfo) => {
    const scope = captureScope();
    setBusy(m.id);
    try {
      await automationModuleRemove(m.id);
      if (!scope.current()) return;
      reload();
      // Nothing rewrites the projects that used it, so say so plainly.
      toast.ok(t("modulesCard.removed", { name: m.name }));
    } catch (e) {
      if (scope.current()) toast.fail({ title: t("modulesCard.removeFailed", { name: m.name }), detail: e });
    } finally {
      if (scope.current()) setBusy(null);
    }
  };

  const openFolder = async () => {
    const scope = captureScope();
    try {
      const path = await automationModulesDir();
      if (!scope.current()) return;
      await revealItemInDir(path);
    } catch {
      if (scope.current()) toast.err(t("modulesCard.folderOpenFailed"));
    }
  };

  return { modules, loaded, busy, add, remove, openFolder };
}
