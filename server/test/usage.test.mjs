import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectUsage, parseRolloutFile, parseUpdatePlanCall } from "../usage.mjs";
import { SnapshotStore } from "../store.mjs";

function event(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test("cache aggregation weights input counts and preserves missing or zero denominators", async () => {
  for (const variant of ["weighted", "missing", "zero"]) {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const first = variant === "zero" ? { input_tokens: 0, cached_input_tokens: 0, total_tokens: 1 }
      : { input_tokens: 10, cached_input_tokens: 9, total_tokens: 11 };
    const second = variant === "zero" ? { input_tokens: 0, cached_input_tokens: 0, total_tokens: 2 }
      : { input_tokens: 100, ...(variant === "missing" ? {} : { cached_input_tokens: 9 }), total_tokens: 102 };
    const { root, filePath } = await fixture(id, [
      event("2026-08-28T00:00:00.000Z", "session_meta", { id }),
      event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
      event("2026-08-28T00:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: first } }),
      event("2026-08-28T00:00:03.000Z", "event_msg", { type: "token_count", info: { total_token_usage: second } }),
    ]);
    try {
      for (const range of ["today", "all"]) {
        const dashboard = await collectUsage({ range, now: new Date("2026-08-28T08:00:00Z"), codexHome: root, files: [filePath] });
        for (const breakdown of [dashboard.models[0].breakdown, dashboard.conversations[0].breakdown, dashboard.conversations[0].modelUsage[0].breakdown]) {
          assert.equal(breakdown.cacheTokensKnown, variant !== "missing");
          if (variant === "weighted") {
            assert.equal(breakdown.inputTokens, 100);
            assert.equal(breakdown.cachedInputTokens, 9);
            assert.equal(breakdown.cachedInputTokens / breakdown.inputTokens, 0.09);
          }
          if (variant === "zero") assert.equal(breakdown.inputTokens, 0);
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

async function fixture(threadId, lines, index = [], fileSuffix = threadId) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-usage-test-"));
  const sessions = path.join(root, "sessions", "2026", "08", "28");
  await mkdir(sessions, { recursive: true });
  const filePath = path.join(sessions, `rollout-2026-08-28T08-00-00-${fileSuffix}.jsonl`);
  await writeFile(filePath, `${lines.join("\n")}\n`);
  await writeFile(
    path.join(root, "session_index.jsonl"),
    `${index.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return { root, filePath };
}

test("uses session metadata instead of a continuation suffix as the conversation id", async () => {
  const threadId = "55555555-5555-4555-8555-555555555555";
  const windowId = "66666666-6666-4666-8666-666666666666";
  const { root, filePath } = await fixture(threadId, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id: threadId, session_id: threadId, source: "vscode" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, total_tokens: 100 } } }),
  ], [{ id: threadId, thread_name: "续接任务的真实标题" }], `${threadId}_${windowId}`);

  const parsed = await parseRolloutFile(filePath);
  assert.equal(parsed.threadId, threadId);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  assert.equal(dashboard.conversations[0].id, threadId);
  assert.equal(dashboard.conversations[0].title, "续接任务的真实标题");
});

test("attributes cumulative token deltas to the nearest model and effort", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const { filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, source: "vscode" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 100 } } }),
    event("2026-08-28T00:00:03.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 135, cached_input_tokens: 85, output_tokens: 15, reasoning_output_tokens: 6, total_tokens: 150 } } }),
    event("2026-08-28T00:00:04.000Z", "turn_context", { model: "gpt-5.6-luna", effort: "max" }),
    event("2026-08-28T00:00:05.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 207, cached_input_tokens: 125, output_tokens: 23, reasoning_output_tokens: 9, total_tokens: 230 } } }),
  ]);

  const parsed = await parseRolloutFile(filePath);
  assert.equal(parsed.usageEvents.length, 3);
  assert.deepEqual(parsed.usageEvents.map((item) => [item.model, item.effort, item.totalTokens]), [
    ["gpt-5.6-sol", "xhigh", 100],
    ["gpt-5.6-sol", "xhigh", 50],
    ["gpt-5.6-luna", "max", 80],
  ]);
});

test("exposes each task's model and effort totals in every dashboard range", async () => {
  const id = "12121212-1212-4121-8121-121212121212";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, cwd: "/Users/example/projects/model-usage" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, total_tokens: 100 } },
    }),
    event("2026-08-28T00:00:03.000Z", "turn_context", { model: "gpt-5.6-luna", effort: "max" }),
    event("2026-08-28T00:00:04.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 135, cached_input_tokens: 85, output_tokens: 15, total_tokens: 150 } },
    }),
  ], [{ id, thread_name: "模型用量明细" }]);
  const now = new Date("2026-08-28T08:00:00.000Z");
  const indexStore = {
    listRolloutIndex: () => [],
    saveRolloutIndex: () => {},
  };

  for (const range of ["today", "7d", "30d", "all"]) {
    const dashboard = await collectUsage({
      range,
      now,
      codexHome: root,
      files: [filePath],
      indexStore,
    });
    const usage = dashboard.conversations[0].modelUsage;
    assert.deepEqual(usage.map((item) => [item.id, item.tokens]), [
      ["gpt-5.6-sol|xhigh", 100],
      ["gpt-5.6-luna|max", 50],
    ]);
    assert.equal(usage[0].label, "GPT-5.6 SOL · 极高");
    assert.equal(usage[0].breakdown.totalTokens, 100);
    assert.equal(usage[0].share, 100 / 150 * 100);
  }
});

test("excludes startup playback and rolls an explicit child into the parent conversation", async () => {
  const childId = "22222222-2222-4222-8222-222222222222";
  const parentId = "33333333-3333-4333-8333-333333333333";
  const { root, filePath } = await fixture(childId, [
    event("2026-08-28T00:00:00.000Z", "session_meta", {
      id: childId,
      source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_nickname: "Feynman", agent_role: "luna_worker" } } },
    }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 950, cached_input_tokens: 900, output_tokens: 50, total_tokens: 1_000 } } }),
    event("2026-08-28T00:00:06.000Z", "turn_context", { model: "gpt-5.6-luna", effort: "max" }),
    event("2026-08-28T00:00:07.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 35, cached_input_tokens: 20, output_tokens: 5, total_tokens: 40 } } }),
  ], [{ id: parentId, thread_name: "父任务" }]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  assert.equal(dashboard.totals.tokens, 40);
  assert.equal(dashboard.conversations[0].id, parentId);
  assert.equal(dashboard.conversations[0].title, "父任务");
  assert.equal(dashboard.conversations[0].childCount, 1);
  assert.equal(dashboard.conversations[0].modelLabel, "GPT-5.6 Luna");
  assert.equal(dashboard.conversations[0].effortLabel, "Max");
});

test("sanitizes guardian conversations instead of exposing their raw title", async () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, source: { subagent: { other: "guardian" } } }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "codex-auto-review", effort: "low" }),
    event("2026-08-28T00:00:06.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 18, cached_input_tokens: 0, output_tokens: 2, total_tokens: 20 } } }),
  ], [{ id, thread_name: "untrusted private transcript" }]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  assert.equal(dashboard.conversations[0].title, "自动审查（系统汇总）");
  assert.equal(dashboard.conversations[0].isSystem, true);
  assert.equal(dashboard.totals.conversations, 0);
});

test("uses cwd basename and verified update_plan steps for a task", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", {
      id,
      cwd: "/Users/example/projects/usage-insights",
      source: "cli",
    }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({
        plan: [
          { step: "读取本地数据", status: "completed" },
          { step: "展示任务进度", status: "in_progress" },
          { step: "验证空状态", status: "pending" },
        ],
      }),
    }),
    event("2026-08-28T00:00:05.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, total_tokens: 100 } },
    }),
  ], [{ id, thread_name: "任务进度解析" }]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  const task = dashboard.conversations[0];
  assert.equal(task.projectLabel, "usage-insights");
  assert.equal(task.progress.kind, "steps");
  assert.equal(task.progress.completedSteps, 1);
  assert.equal(task.progress.totalSteps, 3);
  assert.equal(task.progress.label, "1/3 步");
  assert.equal(task.status, "1/3 步");
  assert.equal(task.updatedAt, "2026-08-28T00:00:05.000Z");
  const expectedLocalTime = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date("2026-08-28T00:00:05.000Z"));
  assert.equal(task.updatedAtLabel, expectedLocalTime);
});

test("accepts a direct custom_tool_call update_plan but ignores exec source text", () => {
  const customToolPlan = parseUpdatePlanCall({
    type: "custom_tool_call",
    name: "update_plan",
    input: {
      plan: [
        { step: "读取数据", status: "completed" },
        { step: "展示结果", status: "pending" },
      ],
    },
  });
  assert.deepEqual(customToolPlan, {
    kind: "steps",
    completedSteps: 1,
    totalSteps: 2,
    label: "1/2 步",
  });

  assert.equal(parseUpdatePlanCall({
    type: "custom_tool_call",
    name: "exec",
    input: "tools.update_plan({ plan: [{ step: 'not a persisted plan', status: 'pending' }] })",
  }), null);
});

test("does not reuse an old plan after a new turn starts without a new plan", async () => {
  const id = "abababab-abab-4aba-8aba-abababababab";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, cwd: "/Users/example/projects/stale-plan" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "上一轮任务", status: "in_progress" }, { step: "上一轮收尾", status: "pending" }] }),
    }),
    event("2026-08-28T00:00:03.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
    event("2026-08-28T00:00:04.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:05.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 135, cached_input_tokens: 0, output_tokens: 15, total_tokens: 150 } },
    }),
  ], [{ id, thread_name: "新一轮任务" }]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  const task = dashboard.conversations[0];
  assert.equal(task.progress.kind, "none");
  assert.equal(task.status, "今日活跃");
});

test("treats event_msg.task_started as a new turn for completion status", async () => {
  const id = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, cwd: "/Users/example/projects/task-started" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-luna", effort: "max" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
    event("2026-08-28T00:00:03.000Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
    event("2026-08-28T00:00:04.000Z", "event_msg", { type: "task_started", turn_id: "turn-2" }),
  ], [{ id, thread_name: "新任务已启动" }]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  const task = dashboard.conversations[0];
  assert.equal(task.status, "今日活跃");
  assert.equal(task.statusKind, "active");
  assert.equal(task.updatedAt, "2026-08-28T00:00:04.000Z");
});

test("does not infer task progress when no plan is recorded", async () => {
  const id = "88888888-8888-4888-8888-888888888888";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, cwd: "/Users/example/projects/no-plan" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-luna", effort: "max" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
  ]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  const task = dashboard.conversations[0];
  assert.equal(task.projectLabel, "no-plan");
  assert.equal(task.progress.kind, "none");
  assert.equal(task.progress.percent, undefined);
  assert.equal(task.status, "今日活跃");
});

test("does not fall back to an older plan after an invalid latest update_plan call", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, cwd: "/Users/example/projects/invalid-plan" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-28T00:00:02.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "读取数据", status: "in_progress" }] }),
    }),
    event("2026-08-28T00:00:03.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: "{malformed",
    }),
    event("2026-08-28T00:00:04.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
  ]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  assert.equal(dashboard.conversations[0].progress.kind, "none");
  assert.equal(dashboard.conversations[0].status, "今日活跃");
});

test("shows 本轮完成 only when a completion event follows the latest turn", async () => {
  const id = "99999999-9999-4999-8999-999999999999";
  const { root, filePath } = await fixture(id, [
    event("2026-08-28T00:00:00.000Z", "session_meta", { id, cwd: "/Users/example/projects/completed" }),
    event("2026-08-28T00:00:01.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "high" }),
    event("2026-08-28T00:00:02.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
    event("2026-08-28T00:00:03.000Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  ]);

  const dashboard = await collectUsage({
    range: "today",
    now: new Date("2026-08-28T08:00:00.000Z"),
    codexHome: root,
    files: [filePath],
  });
  assert.equal(dashboard.conversations[0].status, "本轮完成");
  assert.equal(dashboard.conversations[0].statusKind, "completed");
  assert.equal(dashboard.conversations[0].updatedAt, "2026-08-28T00:00:03.000Z");
});

test("all range uses the earliest attributable day and aggregates the trend by local month", async () => {
  const id = "12121212-1212-4121-8121-121212121212";
  const { root, filePath } = await fixture(id, [
    event("2026-08-20T12:00:00.000Z", "session_meta", {
      id,
      cwd: "/Users/example/projects/cumulative",
    }),
    event("2026-08-20T12:01:00.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-20T12:02:00.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 10, total_tokens: 100 } },
    }),
    event("2026-09-01T12:01:00.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 162, cached_input_tokens: 100, output_tokens: 18, total_tokens: 180 } },
    }),
    event("2026-09-02T12:01:00.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 207, cached_input_tokens: 120, output_tokens: 23, total_tokens: 230 } },
    }),
  ], [{ id, thread_name: "累计边界任务" }]);
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-usage-all-store-"));
  const store = new SnapshotStore(dataDir);

  try {
    const dashboard = await collectUsage({
      range: "all",
      now: new Date("2026-09-01T12:00:00.000Z"),
      codexHome: root,
      files: [filePath],
      indexStore: store,
    });
    assert.equal(dashboard.periodStart, "2026-08-20");
    assert.equal(dashboard.periodEnd, "2026-09-01");
    assert.equal(dashboard.periodLabel, "累计");
    assert.equal(dashboard.totals.tokens, 180);
    assert.deepEqual(dashboard.chart.map((point) => [point.label, point.tokens]), [
      ["2026年8月", 100],
      ["2026年9月", 80],
    ]);
    assert.equal(dashboard.conversations[0].title, "累计边界任务");
    assert.equal(dashboard.conversations[0].projectLabel, "cumulative");
    assert.equal(dashboard.conversations[0].status, "历史记录");
    assert.equal(dashboard.conversations[0].statusKind, "history");
    assert.equal(dashboard.quality.trendBucket, "local month");
    assert.equal(dashboard.quality.reparsedFiles, 1);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("all range incrementally reuses, updates, and removes rollout index entries", async () => {
  const id = "13131313-1313-4131-8131-131313131313";
  const { root, filePath } = await fixture(id, [
    event("2026-08-20T12:00:00.000Z", "session_meta", { id }),
    event("2026-08-20T12:01:00.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-20T12:02:00.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
  ]);
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-usage-all-index-"));
  const store = new SnapshotStore(dataDir);
  const now = new Date("2026-09-01T18:00:00.000Z");

  try {
    const first = await collectUsage({ range: "all", now, codexHome: root, files: [filePath], indexStore: store });
    const firstRow = store.listRolloutIndex()[0];
    assert.equal(first.quality.reparsedFiles, 1);
    assert.equal(first.quality.reusedFiles, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await collectUsage({ range: "all", now, codexHome: root, files: [filePath], indexStore: store });
    const secondRow = store.listRolloutIndex()[0];
    assert.equal(second.quality.reparsedFiles, 0);
    assert.equal(second.quality.reusedFiles, 1);
    assert.equal(second.quality.removedFiles, 0);
    assert.equal(second.totals.tokens, first.totals.tokens);
    assert.equal(secondRow.indexed_at, firstRow.indexed_at);

    await writeFile(filePath, `${[
      event("2026-08-20T12:00:00.000Z", "session_meta", { id }),
      event("2026-08-20T12:01:00.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
      event("2026-08-20T12:02:00.000Z", "event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
      }),
      event("2026-08-20T12:03:00.000Z", "event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 135, cached_input_tokens: 0, output_tokens: 15, total_tokens: 150 } },
      }),
    ].join("\n")}\n`);
    await utimes(filePath, new Date("2026-09-01T18:01:00.000Z"), new Date("2026-09-01T18:01:00.000Z"));
    const changed = await collectUsage({ range: "all", now, codexHome: root, files: [filePath], indexStore: store });
    assert.equal(changed.quality.reparsedFiles, 1);
    assert.equal(changed.quality.reusedFiles, 0);
    assert.equal(changed.totals.tokens, 150);

    await rm(filePath);
    const removed = await collectUsage({ range: "all", now, codexHome: root, files: [], indexStore: store });
    assert.equal(removed.quality.removedFiles, 1);
    assert.equal(removed.totals.tokens, 0);
    assert.equal(store.listRolloutIndex().length, 0);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("all range de-duplicates an exact continuation copy while retaining distinct activity", async () => {
  const id = "14141414-1414-4141-8141-141414141414";
  const { root, filePath } = await fixture(id, [
    event("2026-08-20T12:00:00.000Z", "session_meta", { id }),
    event("2026-08-20T12:01:00.000Z", "turn_context", { model: "gpt-5.6-sol", effort: "xhigh" }),
    event("2026-08-20T12:02:00.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10, total_tokens: 100 } },
    }),
  ]);
  const duplicatePath = filePath.replace(`${id}.jsonl`, `${id}_duplicate.jsonl`);
  const dataDir = await mkdtemp(path.join(tmpdir(), "codex-usage-all-duplicate-"));
  const store = new SnapshotStore(dataDir);

  try {
    await copyFile(filePath, duplicatePath);
    const dashboard = await collectUsage({
      range: "all",
      now: new Date("2026-09-01T18:00:00.000Z"),
      codexHome: root,
      files: [filePath, duplicatePath],
      indexStore: store,
    });
    assert.equal(dashboard.totals.tokens, 100);
    assert.equal(dashboard.conversations.length, 1);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
