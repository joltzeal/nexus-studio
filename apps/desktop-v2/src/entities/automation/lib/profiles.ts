import { profileList } from "../../profile/model/api";
import { useProfile } from "../../profile/lib/useProfile";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { workspace } from "../../../raccoon/store";
import { captureAutomationScope } from "./scope";

export async function automationProfiles() {
  if (!isNativeRaccoon()) return profileList();
  const scope = captureAutomationScope();
  await workspace.refresh();
  if (!scope.current()) throw new Error("Workspace 已切换");
  return useProfile.getState().profiles;
}
