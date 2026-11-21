import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeAutomationClient } from "./client.ts";
import { parseProject, parseRunState } from "./schemas.ts";

const project = () => ({
  id: "project-a", name: "Test", notes: "", blocks: [],
  run: { threads: 1, loops: 1, hours: 0, profiles: [], start: "" },
  created_at: 1, updated_at: 1,
});

test("native automation reads use explicit commands and connection scope", async () => {
  const calls: unknown[] = [];
  const client = new NativeAutomationClient({
    async call(command, args) { calls.push([command, args]); return [project()]; },
  });
  client.select("connection-a");
  assert.deepEqual(await client.request("list"), [project()]);
  assert.deepEqual(calls, [["browser_automation_list", { connectionId: "connection-a" }]]);
});

test("unconfigured workspaces cannot dispatch automation commands", async () => {
  let calls = 0;
  const client = new NativeAutomationClient({ async call() { calls++; return []; } });
  await assert.rejects(client.request("list"), /Workspace/);
  assert.equal(calls, 0);
});

test("switching away and back invalidates old responses even for the same connection", async () => {
  let resolve!: (value: unknown) => void;
  const client = new NativeAutomationClient({ call: () => new Promise((done) => { resolve = done; }) });
  client.select("a");
  const pending = client.request("list");
  client.select("b");
  client.select("a");
  resolve([project()]);
  await assert.rejects(pending, /Workspace/);
});

test("run retries reuse the same operation ID after an unknown transport result", async () => {
  const ids: unknown[] = [];
  let attempt = 0;
  const client = new NativeAutomationClient({
    async call(_command, args) {
      ids.push(args?.operationId);
      if (attempt++ === 0) throw new Error("connection closed");
      return null;
    },
  }, () => `operation-${attempt}`);
  client.select("a");
  await assert.rejects(client.request("run", { projectId: "project-a" }));
  await client.request("run", { projectId: "project-a" });
  await client.request("run", { projectId: "project-a" });
  assert.deepEqual(ids, ["operation-0", "operation-0", "operation-2"]);
});

test("cleanup remains bound to its captured connection after selection changes", async () => {
  const calls: unknown[] = [];
  const client = new NativeAutomationClient({ async call(command, args) { calls.push([command, args]); return null; } });
  client.select("a");
  client.select("b");
  await client.release("a", "profile-a");
  assert.deepEqual(calls, [["browser_automation_detach", { connectionId: "a", profileId: "profile-a" }]]);
});

test("malformed native project responses are rejected at the boundary", async () => {
  const client = new NativeAutomationClient({ async call() { return [{ ...project(), run: { threads: "1" } }]; } });
  client.select("a");
  await assert.rejects(client.request("list"), /自动化/);
});

test("project validation preserves graph parameters and checks branch and coordinate types", () => {
  const value = {
    ...project(),
    blocks: [{ id: "block-a", kind: "custom.action", label: "", params: { nested: ["a", 3] },
      enabled: true, secrets: ["password"], x: 40, y: 60, on_done: { goto: "block-a" }, on_fail: { retry: 2 } }],
  };
  assert.deepEqual(parseProject(value), value);
  assert.throws(() => parseProject({ ...value, blocks: [{ ...value.blocks[0], x: Infinity }] }), /自动化/);
  assert.throws(() => parseProject({ ...value, blocks: [{ ...value.blocks[0], on_fail: { retry: -1 } }] }), /自动化/);
});

test("recovery statuses remain visible and malformed worker states are rejected", () => {
  const run = { project_id: "project-a", project_name: "Test", started_at: 1, running: false,
    workers: [{ profile_id: "profile-a", profile_name: "Profile", pass: 1, step: 1, steps_total: 2, status: "interrupted", note: "Restarted" }], log: [] };
  assert.deepEqual(parseRunState(run), run);
  assert.throws(() => parseRunState({ ...run, running: "false" }), /自动化/);
});

test("argument scope cannot override the selected connection", async () => {
  const client = new NativeAutomationClient({ async call() { return []; } });
  client.select("a");
  await assert.rejects(client.request("list", { connectionId: "b" }), /Workspace/);
});


test("overlapping duplicate run submissions keep their operation identity until every reply settles", async () => {
  const ids: unknown[] = [];
  const replies: ((value: unknown) => void)[] = [];
  let sequence = 0;
  const client = new NativeAutomationClient({ call: async (_command, args) => {
    ids.push(args?.operationId);
    return new Promise((resolve) => { replies.push(resolve); });
  } }, () => `concurrent-${sequence++}`);
  client.select("a");
  const first = client.request("run", { projectId: "p" });
  const second = client.request("run", { projectId: "p" });
  replies[0](null);
  await first;
  const third = client.request("run", { projectId: "p" });
  assert.deepEqual(ids, ["concurrent-0", "concurrent-0", "concurrent-0"]);
  replies[1](null); replies[2](null);
  await Promise.all([second, third]);
});


test("run reconciliation sends explicit user confirmation and validates recovery state", async () => {
  const calls: unknown[] = [];
  const client = new NativeAutomationClient({ async call(command, args) { calls.push([command, args]); return null; } });
  client.select("a");
  await client.request("run_reconcile", { projectId: "p", confirmed: false });
  await client.request("run_reconcile", { projectId: "p", confirmed: true });
  assert.deepEqual(calls, [
    ["browser_automation_run_reconcile", { connectionId: "a", projectId: "p", confirmed: false }],
    ["browser_automation_run_reconcile", { connectionId: "a", projectId: "p", confirmed: true }],
  ]);
});
