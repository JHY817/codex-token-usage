import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appPath = fileURLToPath(new URL("../src/App.jsx", import.meta.url));
let dashboardUi;

test.before(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "codex-usage-ui-test-"));
  const bundlePath = path.join(temp, "app.mjs");
  await build({
    entryPoints: [appPath],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "node",
    logLevel: "silent",
  });
  dashboardUi = await import(pathToFileURL(bundlePath).href);
});

test("cache labels use the weighted input share and preserve unknown data", () => {
  assert.equal(dashboardUi.cacheRateLabel({ inputTokens: 1000, cachedInputTokens: 750, cacheTokensKnown: true }), "缓存 75.0%");
  assert.equal(dashboardUi.cacheRateLabel({ inputTokens: 1000, cachedInputTokens: 0, cacheTokensKnown: true }), "缓存 0.0%");
  assert.equal(dashboardUi.cacheRateLabel({ inputTokens: 300, cachedInputTokens: 100, cacheTokensKnown: true }), "缓存 33.3%");
  for (const breakdown of [null, {}, { inputTokens: 0, cachedInputTokens: 0, cacheTokensKnown: true }, { inputTokens: 1, cacheTokensKnown: true }, { inputTokens: 1, cachedInputTokens: 2, cacheTokensKnown: true }, { inputTokens: 100, cachedInputTokens: 80 }, { inputTokens: 100, cachedInputTokens: 80, cacheTokensKnown: false }]) {
    assert.equal(dashboardUi.cacheRateLabel(breakdown), "缓存 —");
  }
  const cumulativeBreakdowns = { task: { inputTokens: 100, cachedInputTokens: 40 } };
  assert.deepEqual(dashboardUi.extractConversationCacheBreakdowns({ structuredContent: { cumulativeBreakdowns } }), cumulativeBreakdowns);
  assert.deepEqual(dashboardUi.extractConversationCacheBreakdowns({ totals: { task: 100 } }), {});
  const todayBreakdown = { inputTokens: 10, cachedInputTokens: 8 };
  const rows = dashboardUi.buildConversationUsageRows({ models: [{ id: "model", todayBreakdown, cumulativeBreakdown: cumulativeBreakdowns.task }] });
  assert.deepEqual(rows[0].todayBreakdown, todayBreakdown);
  assert.deepEqual(rows[0].cumulativeBreakdown, cumulativeBreakdowns.task);
});

test("supports the four dashboard periods and prevents hiding every model", () => {
  assert.deepEqual(dashboardUi.RANGE_OPTIONS.map((option) => option.id), ["today", "7d", "30d", "all"]);
  assert.equal(dashboardUi.normalizeDashboardRange("7d"), "7d");
  assert.equal(dashboardUi.normalizeDashboardRange("all"), "all");
  assert.equal(dashboardUi.normalizeDashboardRange("unsupported"), "today");

  let hidden = dashboardUi.toggleModelVisibility(new Set(), "sol", 3);
  hidden = dashboardUi.toggleModelVisibility(hidden, "luna", 3);
  hidden = dashboardUi.toggleModelVisibility(hidden, "legacy", 3);
  assert.deepEqual([...hidden], ["sol", "luna"]);
  hidden = dashboardUi.toggleModelVisibility(hidden, "sol", 3);
  assert.deepEqual([...hidden], ["luna"]);
});

test("extracts batched cumulative conversation totals and normalizes invalid values", () => {
  assert.deepEqual(
    dashboardUi.extractConversationUsageTotals({
      structuredContent: {
        totals: {
          "task-a": 123,
          "task-b": "456",
          "task-c": -1,
          "task-d": "not-a-number",
        },
      },
    }),
    {
      "task-a": 123,
      "task-b": 456,
      "task-c": 0,
      "task-d": 0,
    },
  );
  assert.equal(dashboardUi.extractConversationUsageTotals({ totals: [] }), null);
});

test("compresses long model lists into top five plus a summed other series", () => {
  const models = [
    ["m1", 700, 70],
    ["m2", 600, 60],
    ["m3", 500, 50],
    ["m4", 400, 40],
    ["m5", 300, 30],
    ["m6", 200, 20],
    ["m7", 100, 10],
  ].map(([id, tokens, share]) => ({
    id,
    label: id,
    tokens,
    share,
    breakdown: {
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: tokens,
    },
  }));
  const points = models.flatMap((model, index) => [
    { x: 0, label: "2026年1月", seriesId: model.id, tokens: (index + 1) * 10 },
    { x: 1, label: "2026年2月", seriesId: model.id, tokens: (index + 1) * 20 },
  ]);

  const compressed = dashboardUi.compressModelSeries(models, points);
  assert.deepEqual(compressed.models.map((model) => model.id), ["m1", "m2", "m3", "m4", "__other_model_effort__"]);
  assert.equal(compressed.models.length, 5);
  const other = compressed.models.at(-1);
  assert.equal(other.label, "其他模型/档位");
  assert.equal(other.tokens, 600);
  assert.equal(other.share, 60);
  assert.equal(other.breakdown.totalTokens, 600);
  assert.deepEqual(
    compressed.points.filter((point) => point.seriesId === other.id).map((point) => point.tokens),
    [180, 360],
  );
  assert.equal(compressed.points.filter((point) => point.seriesId === other.id).length, 2);

  const unchangedModels = models.slice(0, 5);
  const unchangedPoints = points.filter((point) => unchangedModels.some((model) => model.id === point.seriesId));
  const unchanged = dashboardUi.compressModelSeries(unchangedModels, unchangedPoints);
  assert.equal(unchanged.models, unchangedModels);
  assert.equal(unchanged.points, unchangedPoints);
});

test("aggregates a shared time point and excludes hidden model series", () => {
  const models = [
    { id: "sol", label: "GPT-5.6 SOL · 极高", color: "#2866F7" },
    { id: "luna", label: "GPT-5.6 Luna · Max", color: "#8B6DFF" },
  ];
  const points = [
    { x: 0, label: "00:00", seriesId: "sol", tokens: 1_200_000 },
    { x: 0, label: "00:00", seriesId: "luna", tokens: 300_000 },
    { x: 1, label: "01:00", seriesId: "sol", tokens: 500_000 },
    { x: 1, label: "01:00", seriesId: "luna", tokens: 800_000 },
  ];

  const summaries = dashboardUi.aggregateChartSummaries(points, models);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].totalTokens, 1_500_000);
  assert.deepEqual(summaries[0].series.map((series) => series.tokens), [1_200_000, 300_000]);

  const visibleOnly = dashboardUi.aggregateChartSummaries(points, models, new Set(["luna"]));
  assert.equal(visibleOnly[0].totalTokens, 1_200_000);
  assert.deepEqual(visibleOnly[0].series.map((series) => series.id), ["sol"]);
});

test("supports hover nearest-point lookup and explicit pin/unpin selection", () => {
  const models = [{ id: "sol", label: "GPT-5.6 SOL · 极高", color: "#2866F7" }];
  const summaries = dashboardUi.aggregateChartSummaries([
    { x: 0, label: "00:00", seriesId: "sol", tokens: 1_000_000 },
    { x: 12, label: "12:00", seriesId: "sol", tokens: 2_000_000 },
    { x: 23, label: "23:00", seriesId: "sol", tokens: 3_000_000 },
  ], models);

  const midday = dashboardUi.nearestChartSummary(summaries, 0.5, "today");
  assert.equal(midday.key, "number:12");
  assert.equal(dashboardUi.nextChartSelection(midday), "number:12");
  assert.equal(dashboardUi.nextChartSelection(null), null);
  assert.equal(dashboardUi.nearestChartSummary(summaries, -0.1, "today"), null);
  assert.equal(dashboardUi.nearestChartSummary(summaries, 1.1, "today"), null);
});

test("anchors hover selection at the centre of categorical bars", () => {
  const first = dashboardUi.chartPointPosition({ x: 0 }, 0, 24, "today");
  const middle = dashboardUi.chartPointPosition({ x: 12 }, 12, 24, "today");
  const last = dashboardUi.chartPointPosition({ x: 23 }, 23, 24, "today");
  assert.ok(first > 0 && first < 0.05);
  assert.ok(middle > 0.48 && middle < 0.54);
  assert.ok(last > 0.95 && last < 1);
  assert.ok(first < middle && middle < last);

  const single = dashboardUi.bandCenterPosition(0, 1, 0.28, 0.08);
  assert.ok(Math.abs(single - 0.5) < 1e-9);
});

test("omits zero-consumption model rows from chart summaries", () => {
  const series = [
    { id: "active", tokens: 120 },
    { id: "zero", tokens: 0 },
    { id: "negative", tokens: -1 },
    { id: "missing", tokens: null },
  ];
  assert.deepEqual(
    dashboardUi.nonZeroChartSeries(series).map((item) => item.id),
    ["active"],
  );
});

test("keeps conversation comparison bars on one scale and preserves zero/minimum widths", () => {
  const rows = dashboardUi.buildConversationUsageRows({
    models: [
      { id: "history|high", label: "历史模型 · 高", cumulativeTokens: 90, cumulativeShare: 100 },
      { id: "today|max", label: "今日模型 · Max", todayTokens: 10, todayShare: 100 },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.id, row.todayTokens, row.cumulativeTokens]), [
    ["history|high", 0, 90],
    ["today|max", 10, 0],
  ]);

  assert.equal(dashboardUi.comparisonBarWidth(25, 100), 25);
  assert.equal(dashboardUi.comparisonBarWidth(50, 100), 50);
  assert.equal(dashboardUi.comparisonBarWidth(0, 100), 0);
  assert.deepEqual(dashboardUi.comparisonBarStyle(0, 100), {
    width: "0%",
    minWidth: "0px",
  });
  const tiny = dashboardUi.comparisonBarStyle(1, 1_000_000);
  assert.ok(Math.abs(Number.parseFloat(tiny.width) - 0.0001) < 1e-12);
  assert.equal(tiny.minWidth, "2px");
});

test("keeps credits null-aware and unions official-only detail models", () => {
  assert.deepEqual(
    [null, undefined, false, "", 0, 12.5].map((value) => dashboardUi.numericCredit(value)),
    [null, null, null, null, 0, 12.5],
  );

  const official = dashboardUi.normalizeOfficialUsage({
    available: true,
    totalCredits: "",
    models: [
      { id: "null-model", label: "空值", credits: null },
      { id: "zero-model", label: "零值", credits: 0 },
      { id: "valid-model", label: "有效", credits: 12.5 },
    ],
    daily: [
      { date: "2026-09-07", credits: null, models: [
        { id: "null-model", label: "空值", credits: null },
        { id: "zero-model", label: "零值", credits: 0 },
        { id: "valid-model", label: "有效", credits: 12.5 },
      ] },
    ],
  }, "today");
  assert.equal(official.totalCredits, null);
  assert.deepEqual(official.models.map((model) => model.credits), [null, 0, 12.5]);
  assert.deepEqual(dashboardUi.buildCreditSeries(official).points.map((point) => point.tokens), [0, 12.5]);

  const detail = dashboardUi.extractConversationDetail({
    structuredContent: {
      detail: {
        models: [{ id: "token-only", label: "Token 模型", todayTokens: 10 }],
        credits: {
          available: true,
          todayCredits: false,
          cumulativeCredits: "",
          models: [
            { id: "token-only", label: "Token 模型", todayCredits: null },
            { id: "official-only", label: "官方模型", todayCredits: 3 },
          ],
        },
      },
    },
  });
  assert.equal(detail.credits.todayCredits, false);
  assert.deepEqual(
    dashboardUi.buildConversationUsageRows(detail).map((row) => [row.id, row.todayCredits]),
    [["token-only", null], ["official-only", 3]],
  );
});

test("task and model token values use ten-thousand units without hiding missing data", () => {
  assert.equal(dashboardUi.formatChartTokens(null), "—");
  assert.equal(dashboardUi.formatChartTokens(0), "0 万");
  assert.equal(dashboardUi.formatChartTokens(1_234_500), "123.45 万");
  assert.equal(dashboardUi.conversationTokenLabel(1_234_500), "123.45 万");
  assert.equal(dashboardUi.conversationTokenLabel(1_234_500, true), "—");
});

test("stacked chart scale accommodates the full bucket instead of one model", () => {
  assert.equal(dashboardUi.stackedPointMaximum([
    {x: 0, tokens: 80}, {x: 0, tokens: 70}, {x: 1, tokens: 90},
  ]), 150);
  assert.equal(dashboardUi.stackedPointMaximum([]), 0);
});

test("places the portal trend summary above or below its anchor without leaving the viewport", () => {
  assert.deepEqual(dashboardUi.clampTooltipPosition({
    anchorX: 600,
    anchorY: 400,
    width: 200,
    height: 120,
    viewportWidth: 1000,
    viewportHeight: 800,
  }), { left: 500, top: 268, placement: "above" });
  assert.deepEqual(dashboardUi.clampTooltipPosition({
    anchorX: 20,
    anchorY: 20,
    width: 200,
    height: 120,
    viewportWidth: 1000,
    viewportHeight: 800,
  }), { left: 12, top: 32, placement: "below" });
});

test("compacts an oversized model summary without changing its source list", () => {
  const models = [
    { id: "m1", tokens: 700, share: 70 },
    { id: "m2", tokens: 600, share: 60 },
    { id: "m3", tokens: 500, share: 50 },
    { id: "m4", tokens: 400, share: 40 },
    { id: "m5", tokens: 300, share: 30 },
    { id: "m6", tokens: 200, share: 20 },
    { id: "m7", tokens: 100, share: 10 },
  ];
  const compacted = dashboardUi.compactModelBreakdownModels(models);
  assert.deepEqual(compacted.map((model) => model.id), ["m1", "m2", "m3", "m4", "__model-breakdown-other__"]);
  assert.equal(compacted.at(-1).tokens, 600);
  assert.equal(compacted.at(-1).share, 60);
  assert.equal(models.length, 7);
});
