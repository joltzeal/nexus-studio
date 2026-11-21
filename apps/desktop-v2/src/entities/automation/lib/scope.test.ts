import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAutomationScope } from "./scope.ts";
import { registerNativeAutomationPreview, releaseNativeAutomationPreviews } from "./nativePreview.ts";
import { activateNativeRaccoon } from "../../../raccoon/runtime.ts";
import { configureAutomationTransport, isAutomationEventCurrent, setAutomationConnection } from "../../../raccoon/automation/context.ts";

activateNativeRaccoon();

test("an async effect expires across A to B to A", () => {
  setAutomationConnection("a");
  const scope = captureAutomationScope();
  assert.equal(scope.connectionId, "a");
  assert.equal(scope.current(), true);
  setAutomationConnection("b");
  setAutomationConnection("a");
  assert.equal(scope.current(), false);
});

test("native events require the active connection identity", () => {
  setAutomationConnection("a");
  assert.equal(isAutomationEventCurrent({}), false);
  assert.equal(isAutomationEventCurrent({ connection_id: "b" }), false);
  assert.equal(isAutomationEventCurrent({ connection_id: "a" }), true);
  setAutomationConnection(null);
  assert.equal(isAutomationEventCurrent({ connection_id: "a" }), false);
});

test("preview cleanup retains its original connection and never stops a run", async () => {
  const calls: unknown[] = [];
  configureAutomationTransport(async (command, args) => { calls.push([command, args]); return null; });
  setAutomationConnection("a");
  const close = registerNativeAutomationPreview("a", "profile-a");
  setAutomationConnection("b");
  await close();
  assert.deepEqual(calls, [["browser_automation_detach", { connectionId: "a", profileId: "profile-a" }]]);
});

test("workspace cleanup releases only previews from the departing connection", async () => {
  const calls: unknown[] = [];
  configureAutomationTransport(async (command, args) => { calls.push([command, args]); return null; });
  const closeA = registerNativeAutomationPreview("a", "profile-a");
  const closeB = registerNativeAutomationPreview("b", "profile-b");
  releaseNativeAutomationPreviews("a");
  await Promise.resolve();
  assert.deepEqual(calls, [["browser_automation_detach", { connectionId: "a", profileId: "profile-a" }]]);
  await closeB();
  // Close callbacks can be used again when a late launch resolves after cleanup.
  await closeA();
  assert.equal(calls.length, 3);
});
