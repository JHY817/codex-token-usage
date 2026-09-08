import assert from "node:assert/strict";
import test from "node:test";
import { UsageService } from "../service.mjs";

test("old snapshots are rebuilt to recover cache-field availability", async () => {
  let refreshed = false;
  const service = new UsageService({
    store: { loadLatest: () => ({ version: 1, periodEnd: "2026-08-28" }), save: (value) => value },
    collector: async () => { refreshed = true; return { version: 2 }; },
  });
  await service.getDashboard("today", new Date(2026, 7, 28, 12));
  assert.equal(refreshed, true);
});

test("detail and batch totals preserve raw cache denominators and unknown breakdowns", async () => {
  const todayBreakdown = { inputTokens: 10, cachedInputTokens: 9, cacheTokensKnown: true };
  const cumulativeBreakdown = { inputTokens: 100, cachedInputTokens: 9, cacheTokensKnown: true };
  const service = new UsageService({ store: {}, creditsReader: async () => null });
  let reads = 0;
  service.getDashboard = async (range) => {
    reads++;
    const breakdown = range === "today" ? todayBreakdown : cumulativeBreakdown;
    return { conversations: [{ id: "known", tokens: 100, breakdown,
      modelUsage: [{ id: "model", tokens: 100, breakdown }] }, { id: "unknown", tokens: 1 }] };
  };
  const detail = await service.getConversationUsageDetail("known");
  assert.deepEqual(detail.todayBreakdown, todayBreakdown);
  assert.deepEqual(detail.cumulativeBreakdown, cumulativeBreakdown);
  assert.deepEqual(detail.models[0].todayBreakdown, todayBreakdown);
  assert.deepEqual(detail.models[0].cumulativeBreakdown, cumulativeBreakdown);
  reads = 0;
  const batch = await service.getConversationUsageTotals(["known", "unknown", "missing"], new Date(), { includeBreakdowns: true });
  assert.equal(reads, 1);
  assert.deepEqual(batch, { totals: { known: 100, unknown: 1, missing: 0 },
    cumulativeBreakdowns: { known: cumulativeBreakdown, unknown: null, missing: null } });
});

test("slow credits returns pending without blocking Token detail and can finish in background", async () => {
  let complete;
  let result;
  const background = new Promise((resolve) => { complete = resolve; }).then((value) => { result = value; return value; });
  const service = new UsageService({ store: { close() {} }, creditsWaitMs: 5,
    creditsReader: () => result ?? background,
  });
  service.getDashboard = async () => ({ conversations: [{ id: "slow", tokens: 100, modelUsage: [] }] });
  const detail = await service.getConversationUsageDetail("slow");
  assert.equal(detail.todayTokens, 100);
  assert.equal(detail.credits.pending, true);
  assert.equal(detail.credits.cumulativeCredits, null);
  assert.equal(detail.credits.retryAfterMs, 1500);
  complete({ available: true, cumulativeCredits: 3, todayCredits: null });
  await background;
  const next = await service.getConversationUsageDetail("slow");
  assert.equal(next.credits.cumulativeCredits, 3);
  assert.equal(next.credits.pending, undefined);
});

function dashboard(periodEnd, tokens, dataSource = "local") {
  return {
    version: 2,
    range: "today",
    periodStart: periodEnd,
    periodEnd,
    generatedAt: `${periodEnd}T12:00:00.000Z`,
    dataSource,
    totals: { tokens },
    quality: { usage: "test" },
  };
}

test("returns a same-day cache as an explicitly labeled snapshot", async () => {
  let collected = 0;
  const cached = dashboard("2026-08-28", 20);
  const service = new UsageService({
    store: {
      loadLatest: () => cached,
      save: (value) => value,
      close: () => {},
    },
    collector: async () => {
      collected += 1;
      return dashboard("2026-08-28", 30);
    },
  });

  const result = await service.getDashboard("today", new Date("2026-08-28T13:00:00+08:00"));
  assert.equal(collected, 0);
  assert.equal(result.totals.tokens, 20);
  assert.equal(result.dataSource, "snapshot");
  assert.equal(result.quality.snapshotGeneratedAt, cached.generatedAt);
});

test("refreshes a cache whose period no longer ends today", async () => {
  let collectedArgs = null;
  let saved = null;
  const service = new UsageService({
    store: {
      loadLatest: () => dashboard("2026-08-27", 10),
      save: (value) => {
        saved = value;
        return value;
      },
      close: () => {},
    },
    collector: async (args) => {
      collectedArgs = args;
      return dashboard("2026-08-28", 40);
    },
  });
  const now = new Date("2026-08-28T13:00:00+08:00");
  const result = await service.getDashboard("today", now);

  assert.equal(collectedArgs.range, "today");
  assert.equal(collectedArgs.now, now);
  assert.equal(saved.totals.tokens, 40);
  assert.equal(result.totals.tokens, 40);
});

test("returns a conversation model and effort comparison across today and cumulative ranges", async () => {
  const conversationId = "task-detail-1";
  const todayDashboard = {
    ...dashboard("2026-08-28", 150),
    range: "today",
    conversations: [{
      id: conversationId,
      title: "今日任务",
      projectLabel: "usage-plugin",
      tokens: 150,
      toolCalls: 3,
      turns: 2,
      childCount: 1,
      modelUsage: [
        { id: "gpt-5.6-sol|xhigh", label: "GPT-5.6 SOL · 极高", tokens: 100, share: 66.6667 },
        { id: "gpt-5.6-luna|max", label: "GPT-5.6 Luna · Max", tokens: 50, share: 33.3333 },
      ],
    }],
  };
  const cumulativeDashboard = {
    ...dashboard("2026-08-28", 1_000),
    range: "all",
    conversations: [{
      id: conversationId,
      title: "今日任务",
      projectLabel: "usage-plugin",
      tokens: 1_000,
      toolCalls: 8,
      turns: 5,
      childCount: 2,
      modelUsage: [
        { id: "gpt-5.6-sol|xhigh", label: "GPT-5.6 SOL · 极高", tokens: 700, share: 70 },
        { id: "gpt-5.4|high", label: "GPT-5.4 · 高", tokens: 300, share: 30 },
      ],
    }],
  };
  const service = new UsageService({
    store: {
      loadLatest: () => null,
      save: (value) => value,
      close: () => {},
    },
    collector: async ({ range }) => range === "all" ? cumulativeDashboard : todayDashboard,
    creditsReader: async () => ({ available: true, todayCredits: null, cumulativeCredits: 2 }),
  });

  const detail = await service.getConversationUsageDetail(conversationId, new Date("2026-08-28T13:00:00+08:00"));
  assert.deepEqual(detail, {
    credits: { available: true, todayCredits: null, cumulativeCredits: 2 },
    conversation: {
      id: conversationId,
      title: "今日任务",
      projectLabel: "usage-plugin",
      toolCalls: 3,
      turns: 2,
      childCount: 1,
    },
    todayTokens: 150,
    cumulativeTokens: 1_000,
    todayBreakdown: null,
    cumulativeBreakdown: null,
    models: [
      {
        id: "gpt-5.6-sol|xhigh",
        label: "GPT-5.6 SOL · 极高",
        todayTokens: 100,
        cumulativeTokens: 700,
        todayShare: 66.6667,
        cumulativeShare: 70,
        todayBreakdown: null,
        cumulativeBreakdown: null,
      },
      {
        id: "gpt-5.4|high",
        label: "GPT-5.4 · 高",
        todayTokens: 0,
        cumulativeTokens: 300,
        todayShare: 0,
        cumulativeShare: 30,
        todayBreakdown: null,
        cumulativeBreakdown: null,
      },
      {
        id: "gpt-5.6-luna|max",
        label: "GPT-5.6 Luna · Max",
        todayTokens: 50,
        cumulativeTokens: 0,
        todayShare: 33.3333,
        cumulativeShare: 0,
        todayBreakdown: null,
        cumulativeBreakdown: null,
      },
    ],
  });
});

test("uses zero today totals when a cumulative task has no activity today", async () => {
  const conversationId = "task-only-history";
  const cumulativeDashboard = {
    ...dashboard("2026-08-28", 800),
    range: "all",
    conversations: [{
      id: conversationId,
      title: "历史任务",
      projectLabel: "usage-plugin",
      tokens: 800,
      toolCalls: 4,
      turns: 3,
      childCount: 0,
      modelUsage: [{
        id: "gpt-5.6-sol|xhigh",
        label: "GPT-5.6 SOL · 极高",
        tokens: 800,
        share: 100,
      }],
    }],
  };
  const service = new UsageService({
    store: {
      loadLatest: () => null,
      save: (value) => value,
      close: () => {},
    },
    creditsReader: async () => { throw new Error("official unavailable"); },
    collector: async ({ range }) => range === "all"
      ? cumulativeDashboard
      : { ...dashboard("2026-08-28", 0), range, conversations: [] },
  });

  const detail = await service.getConversationUsageDetail(conversationId, new Date("2026-08-28T13:00:00+08:00"));
  assert.equal(detail.todayTokens, 0);
  assert.equal(detail.credits.available, false);
  assert.equal(detail.credits.cumulativeCredits, null);
  assert.equal(detail.cumulativeTokens, 800);
  assert.equal(detail.models[0].todayTokens, 0);
  assert.equal(detail.models[0].cumulativeTokens, 800);
  assert.deepEqual(detail.conversation, {
    id: conversationId,
    title: "历史任务",
    projectLabel: "usage-plugin",
    toolCalls: 4,
    turns: 3,
    childCount: 0,
  });
});

test("validates conversation detail ids and rejects when the cumulative task is missing", async () => {
  const service = new UsageService({
    store: { loadLatest: () => null, save: (value) => value, close: () => {} },
    collector: async ({ range }) => ({
      ...dashboard("2026-08-28", 0),
      range,
      conversations: [],
    }),
  });
  await assert.rejects(service.getConversationUsageDetail(""), /不能为空/);
  await assert.rejects(service.getConversationUsageDetail("x".repeat(161)), /160/);
  await assert.rejects(service.getConversationUsageDetail("missing-task"), /累计/);
});

test("returns cumulative totals for deduplicated conversation ids with one all-range read", async () => {
  let allReads = 0;
  const cumulativeDashboard = {
    ...dashboard("2026-08-28", 1_000),
    range: "all",
    conversations: [
      { id: "task-a", tokens: 700 },
      { id: "task-b", tokens: 300 },
    ],
  };
  const service = new UsageService({
    store: {
      loadLatest: () => null,
      save: (value) => value,
      close: () => {},
    },
    collector: async ({ range }) => {
      assert.equal(range, "all");
      allReads += 1;
      return cumulativeDashboard;
    },
  });

  const totals = await service.getConversationUsageTotals(
    [" task-a ", "task-a", "task-b", "unknown-task"],
    new Date("2026-08-28T13:00:00+08:00"),
  );
  assert.deepEqual(totals, {
    "task-a": 700,
    "task-b": 300,
    "unknown-task": 0,
  });
  assert.equal(allReads, 1);
});

test("validates the batch conversation id boundary", async () => {
  const service = new UsageService({
    store: { loadLatest: () => null, save: (value) => value, close: () => {} },
    collector: async () => ({ ...dashboard("2026-08-28", 0), range: "all", conversations: [] }),
  });
  await assert.rejects(service.getConversationUsageTotals([]), /非空数组/);
  await assert.rejects(service.getConversationUsageTotals(["x".repeat(161)]), /160/);
  await assert.rejects(service.getConversationUsageTotals(Array.from({ length: 21 }, (_, index) => `task-${index}`)), /20/);
});
