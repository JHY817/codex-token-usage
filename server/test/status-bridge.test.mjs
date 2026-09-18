import assert from "node:assert/strict";
import test from "node:test";
import { CodexStatusBridge, findAppServerSocket, mergeActivityStatus, reduceBridgeStatus } from "../status-bridge.mjs";

function at(value) {
  return Date.parse(value);
}

test("structured status reducer gives waiting confirmation the highest priority", () => {
  const result = reduceBridgeStatus(new Map([
    ["running", { state: "running", updatedAtMs: at("2026-09-10T08:00:01Z") }],
    ["waiting", { state: "waiting", updatedAtMs: at("2026-09-10T08:00:02Z") }],
    ["completed", { state: "completed", completedAtMs: at("2026-09-10T08:00:03Z") }],
  ]), { now: new Date("2026-09-10T08:00:04Z") });

  assert.equal(result.status, "waiting");
  assert.equal(result.activeSessions, 2);
  assert.equal(result.source, "codex-app-server");
});

test("bridge consumes thread/status/changed active flags", () => {
  const bridge = new CodexStatusBridge({ enabled: false, now: () => at("2026-09-10T08:00:00Z") });
  bridge.connected = true;
  bridge.ingest({
    method: "thread/status/changed",
    params: {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  }, at("2026-09-10T08:00:01Z"));

  const snapshot = bridge.getSnapshot({ now: new Date("2026-09-10T08:00:02Z") });
  assert.equal(snapshot.status, "waiting");
  assert.equal(snapshot.activeSessions, 1);
  assert.equal(snapshot.bridge, "connected");
});

test("approval request and resolution move a thread from yellow back to blue", () => {
  const bridge = new CodexStatusBridge({ enabled: false });
  bridge.connected = true;
  bridge.ingest({
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", requestId: "request-1" },
  }, at("2026-09-10T08:00:01Z"));
  assert.equal(bridge.getSnapshot().status, "waiting");

  bridge.ingest({
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "request-1" },
  }, at("2026-09-10T08:00:02Z"));
  assert.equal(bridge.getSnapshot().status, "running");
});

test("idle transition after active work keeps a short green completion state", () => {
  const bridge = new CodexStatusBridge({ enabled: false });
  bridge.connected = true;
  bridge.ingest({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  }, at("2026-09-10T08:00:01Z"));
  bridge.ingest({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "idle" } },
  }, at("2026-09-10T08:00:02Z"));

  assert.equal(bridge.getSnapshot({ now: new Date("2026-09-10T08:00:03Z") }).status, "completed");
  assert.equal(bridge.getSnapshot({ now: new Date("2026-09-10T08:06:00Z") }).status, "idle");
});

test("notLoaded removes a stale active thread from the bridge", () => {
  const bridge = new CodexStatusBridge({ enabled: false });
  bridge.connected = true;
  bridge.ingest({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  }, at("2026-09-10T08:00:01Z"));
  bridge.ingest({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "notLoaded" } },
  }, at("2026-09-10T08:00:02Z"));

  assert.equal(bridge.getSnapshot().status, "idle");
});

test("an unavailable bridge never hides the rollout fallback", () => {
  const local = {
    status: "running",
    activeSessions: 1,
    updatedAt: "2026-09-10T08:00:01.000Z",
    source: "local-rollout-events",
  };
  const bridge = {
    available: false,
    status: "idle",
    activeSessions: 0,
    source: "codex-app-server",
    bridge: "unavailable",
  };
  assert.deepEqual(mergeActivityStatus(local, bridge), local);
});

test("socket discovery is optional and does not invent a private endpoint", async () => {
  assert.equal(await findAppServerSocket({ codexHome: "/tmp/codex-status-bridge-no-home" }), null);
});
