import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readActivityStatus } from "../activity.mjs";

function event(timestamp, type, payload = {}) {
  return JSON.stringify({ timestamp, type, payload });
}

function assistantMessage(timestamp, text) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

async function fixture(lines, modifiedAt) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-activity-test-"));
  const directory = path.join(root, "sessions", "2026", "08", "28");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "rollout-2026-08-28T08-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  const date = new Date(modifiedAt);
  await utimes(filePath, date, date);
  return { root, filePath };
}

test("activity status reports a running task from recent rollout activity", async () => {
  const now = new Date("2026-08-28T08:00:10.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:00:09.000Z", "event_msg", { type: "token_count" }),
  ], "2026-08-28T08:00:09.000Z");
  try {
    assert.deepEqual(await readActivityStatus({ codexHome: root, files: [filePath], now }), {
      status: "running",
      activeSessions: 1,
      updatedAt: "2026-08-28T08:00:09.000Z",
      source: "local-rollout-events",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an explicitly started task stays running through a multi-minute silent reasoning gap", async () => {
  const now = new Date("2026-08-28T08:02:20.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:00:10.000Z", "event_msg", { type: "agent_reasoning" }),
  ], "2026-08-28T08:00:10.000Z");
  try {
    const status = await readActivityStatus({ codexHome: root, files: [filePath], now });
    assert.equal(status.status, "running");
    assert.equal(status.activeSessions, 1);
    assert.equal(status.updatedAt, "2026-08-28T08:00:10.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a silent running task still outranks another task that recently completed", async () => {
  const now = new Date("2026-08-28T08:02:20.000Z");
  const running = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:00:10.000Z", "event_msg", { type: "agent_reasoning" }),
  ], "2026-08-28T08:00:10.000Z");
  const completed = await fixture([
    event("2026-08-28T08:01:40.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:02:10.000Z", "event_msg", { type: "task_complete" }),
  ], "2026-08-28T08:02:10.000Z");
  try {
    const status = await readActivityStatus({ files: [running.filePath, completed.filePath], now });
    assert.equal(status.status, "running");
    assert.equal(status.activeSessions, 1);
  } finally {
    await Promise.all([running.root, completed.root].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("an unmatched task start eventually expires after the explicit lifecycle window", async () => {
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
  ], "2026-08-28T08:00:01.000Z");
  try {
    const status = await readActivityStatus({
      codexHome: root,
      files: [filePath],
      now: new Date("2026-08-28T08:31:00.000Z"),
    });
    assert.equal(status.status, "idle");
    assert.equal(status.activeSessions, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("activity status reports an explicit confirmation wait without changing dashboard data", async () => {
  const now = new Date("2026-08-28T08:01:00.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:00:20.000Z", "event_msg", { type: "approval_requested" }),
  ], "2026-08-28T08:00:20.000Z");
  try {
    const status = await readActivityStatus({ codexHome: root, files: [filePath], now });
    assert.equal(status.status, "waiting");
    assert.equal(status.activeSessions, 1);
    assert.equal(status.updatedAt, "2026-08-28T08:00:20.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("activity status exposes a recent completion and ignores stale rollouts", async () => {
  const now = new Date("2026-08-28T08:02:00.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:01:00.000Z", "event_msg", { type: "task_complete" }),
  ], "2026-08-28T08:01:00.000Z");
  try {
    const completed = await readActivityStatus({ codexHome: root, files: [filePath], now });
    assert.equal(completed.status, "completed");
    assert.equal(completed.activeSessions, 0);

    const stale = await readActivityStatus({
      codexHome: root,
      files: [filePath],
      now: new Date("2026-08-28T09:00:00.000Z"),
    });
    assert.equal(stale.status, "idle");
    assert.equal(stale.activeSessions, 0);
    assert.equal(stale.updatedAt, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmation has the highest priority across multiple sessions", async () => {
  const now = new Date("2026-08-28T08:02:00.000Z");
  const fixtures = await Promise.all([
    fixture([
      event("2026-08-28T08:01:40.000Z", "event_msg", { type: "task_started" }),
      event("2026-08-28T08:01:59.000Z", "event_msg", { type: "token_count" }),
    ], "2026-08-28T08:01:59.000Z"),
    fixture([
      event("2026-08-28T08:01:30.000Z", "event_msg", { type: "task_started" }),
      event("2026-08-28T08:01:50.000Z", "event_msg", { type: "task_complete" }),
    ], "2026-08-28T08:01:50.000Z"),
    fixture([
      event("2026-08-28T08:01:20.000Z", "event_msg", { type: "task_started" }),
      assistantMessage("2026-08-28T08:01:55.000Z", "请直接回复“继续授权”，我会继续执行。"),
    ], "2026-08-28T08:01:55.000Z"),
  ]);
  try {
    const status = await readActivityStatus({
      files: fixtures.map(({ filePath }) => filePath),
      now,
    });
    assert.equal(status.status, "waiting");
    assert.equal(status.activeSessions, 2);
  } finally {
    await Promise.all(fixtures.map(({ root }) => rm(root, { recursive: true, force: true })));
  }
});

test("status priority stays blue for running work and green only when all work is complete", async () => {
  const now = new Date("2026-08-28T08:02:00.000Z");
  const running = await fixture([
    event("2026-08-28T08:01:40.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:01:59.000Z", "event_msg", { type: "token_count" }),
  ], "2026-08-28T08:01:59.000Z");
  const completed = await fixture([
    event("2026-08-28T08:01:30.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:01:50.000Z", "event_msg", { type: "task_complete" }),
  ], "2026-08-28T08:01:50.000Z");
  try {
    const mixed = await readActivityStatus({ files: [running.filePath, completed.filePath], now });
    assert.equal(mixed.status, "running");
    assert.equal(mixed.activeSessions, 1);

    const onlyCompleted = await readActivityStatus({ files: [completed.filePath], now });
    assert.equal(onlyCompleted.status, "completed");
    assert.equal(onlyCompleted.activeSessions, 0);
  } finally {
    await Promise.all([running.root, completed.root].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("nested approval states are treated as waiting without scanning arbitrary tool output", async () => {
  const now = new Date("2026-08-28T08:01:00.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    event("2026-08-28T08:00:20.000Z", "event_msg", {
      type: "item_completed",
      item: { type: "approval_request", status: "waiting_user_confirmation" },
    }),
  ], "2026-08-28T08:00:20.000Z");
  try {
    const status = await readActivityStatus({ files: [filePath], now });
    assert.equal(status.status, "waiting");
    assert.equal(status.activeSessions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("technical status names in an assistant explanation do not create a false yellow state", async () => {
  const now = new Date("2026-08-28T08:00:25.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
    assistantMessage("2026-08-28T08:00:20.000Z", "实现会识别 `waiting_user_confirmation` 和 `approval_requested` 事件；只识别自然语言“请确认/等待授权”；“继续授权”只是示例。"),
  ], "2026-08-28T08:00:20.000Z");
  try {
    const status = await readActivityStatus({ files: [filePath], now });
    assert.equal(status.status, "running");
    assert.equal(status.activeSessions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a recently modified rollout is found even when its session date is old", async () => {
  const now = new Date("2026-09-10T08:00:10.000Z");
  const { root, filePath } = await fixture([
    event("2026-08-28T08:00:01.000Z", "event_msg", { type: "task_started" }),
  ], "2026-09-10T08:00:09.000Z");
  try {
    const status = await readActivityStatus({ codexHome: root, now });
    assert.equal(status.status, "running");
    assert.equal(status.activeSessions, 1);
    assert.equal(status.updatedAt, "2026-09-10T08:00:09.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});
