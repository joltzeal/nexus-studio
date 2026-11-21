import { automationClient } from "../../../raccoon/automation/context.ts";

const previews = new Map<symbol, { connectionId: string; close: () => Promise<void> }>();

export function registerNativeAutomationPreview(connectionId: string, profileId: string) {
  const token = Symbol(profileId);
  const close = () => automationClient.release(connectionId, profileId);
  previews.set(token, { connectionId, close });
  return async () => {
    previews.delete(token);
    await close();
  };
}

/** A Workspace change releases editor sessions without stopping any run. */
export function releaseNativeAutomationPreviews(connectionId: string | null | undefined) {
  for (const [token, preview] of previews) {
    if (preview.connectionId !== connectionId) continue;
    previews.delete(token);
    void preview.close().catch(() => {});
  }
}
