import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Chart } from "@antv/g2";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  ChatCircleDots,
  CheckCircle,
  Info,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import {
  callTool,
  getInitialDashboard,
  getPrivateToolPayload,
  subscribeToToolResults,
} from "./bridge.js";
export { getPrivateToolPayload } from "./bridge.js";
import { createRangeRefreshGate, dashboardNeedsRefresh } from "./refresh-policy.js";

export const RANGE_OPTIONS = [
  { id: "today", label: "今天" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "all", label: "累计" },
];

export function normalizeDashboardRange(range) {
  return RANGE_OPTIONS.some((option) => option.id === range) ? range : "today";
}

export function toggleModelVisibility(hiddenSeries, modelId, modelCount) {
  const next = new Set(hiddenSeries ?? []);
  if (next.has(modelId)) next.delete(modelId);
  else if (next.size < Math.max(0, modelCount - 1)) next.add(modelId);
  return next;
}

function emptyDashboardForRange(range = "today", dataSource = "loading") {
  const periodLabel = range === "today"
    ? "今天"
    : range === "7d"
      ? "最近 7 天"
      : range === "30d" ? "最近 30 天" : "累计";
  return {
    version: 1,
    range,
    periodLabel,
    generatedAt: null,
    dataSource,
    totals: { tokens: 0, conversations: 0, tasks: 0, toolCalls: 0, cacheShare: 0 },
    models: [],
    chart: [],
    conversations: [],
    tasks: [],
    quality: {},
  };
}

function formatWan(value) {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value / 10_000).toLocaleString("zh-CN");
}

function formatTaskTokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 10_000) return (value / 10_000).toFixed(2);
  return formatWan(value);
}

function formatCompactTokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  return `${Math.round(value / 10_000).toLocaleString("zh-CN")} 万`;
}

function formatCredits(value) {
  if (!Number.isFinite(value)) return "暂不可用";
  if (Number.isInteger(value)) return value.toLocaleString("zh-CN");
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatCreditsShort(value) {
  if (!Number.isFinite(value)) return "暂不可用";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMetricValue(value, metric = "tokens") {
  return metric === "credits" ? formatCreditsShort(value) : formatTaskTokens(value);
}

function formatDetailMetric(value, metric = "tokens") {
  if (metric === "credits") return formatCredits(value);
  return formatCompactTokens(value);
}

function metricUnit(metric = "tokens") {
  return metric === "credits" ? "Credits" : "Token";
}

function formatMillions(value) {
  if (!Number.isFinite(value)) return "—";
  return (value / 1_000_000).toFixed(2);
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatQuotaWindow(windowDurationMins) {
  const minutes = Number(windowDurationMins);
  if (!Number.isFinite(minutes) || minutes <= 0) return "当前额度剩余";
  if (minutes >= 24 * 60) {
    const days = minutes / (24 * 60);
    if (Number.isInteger(days)) return `${days} 日额度剩余`;
    return `${days.toFixed(1)} 日额度剩余`;
  }
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时额度剩余`;
  return `${Math.round(minutes)} 分钟额度剩余`;
}

export function stackedPointMaximum(points) {
  const buckets = new Map();
  for (const point of points) {
    const key = `${typeof point.x}:${String(point.x)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + Math.max(0, numericValue(point.tokens)));
  }
  return Math.max(0, ...buckets.values());
}

function niceTokenMaximum(points) {
  const maximum = stackedPointMaximum(points);
  if (maximum <= 0) return 1_000_000;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const normalized = maximum / magnitude;
  const ceiling = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1_000_000, ceiling * magnitude);
}

function niceValueMaximum(points) {
  const maximum = stackedPointMaximum(points);
  if (maximum <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const normalized = maximum / magnitude;
  const ceiling = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return ceiling * magnitude;
}

function sourceLabel(dataSource) {
  if (dataSource === "local") return "本地实时归因";
  if (dataSource === "snapshot") return "本地快照";
  if (dataSource === "loading") return "正在读取本机记录";
  return "数据读取失败";
}

function extractDashboard(result) {
  const privatePayload = getPrivateToolPayload(result);
  const candidate = privatePayload?.dashboard
    ?? result?.structuredContent?.dashboard
    ?? result?.structuredContent
    ?? result?.dashboard
    ?? result;
  if (!candidate || !candidate.totals || !Array.isArray(candidate.models)) return null;
  return candidate;
}

function emptyOfficialUsage(range = "today", error = null) {
  return {
    available: false,
    source: null,
    fetchedAt: null,
    error,
    timeZone: null,
    range,
    periodStart: null,
    periodEnd: null,
    coverage: null,
    totalCredits: null,
    models: [],
    daily: [],
  };
}

export function numericCredit(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeOfficialUsage(value, range = "today") {
  if (!value || typeof value !== "object") return emptyOfficialUsage(range);
  const models = Array.isArray(value.models)
    ? value.models
      .filter((model) => model && (typeof model.id === "string" || typeof model.label === "string"))
      .map((model, index) => ({
        id: typeof model.id === "string" && model.id.trim() ? model.id : `unknown-model-${index}`,
        label: typeof model.label === "string" && model.label.trim()
          ? model.label
          : (typeof model.id === "string" && model.id.trim() ? model.id : "未知模型/档位"),
        credits: numericCredit(model.credits),
      }))
    : [];
  const daily = Array.isArray(value.daily)
    ? value.daily
      .filter((day) => day && typeof day.date === "string")
      .map((day) => ({
        date: day.date,
        credits: numericCredit(day.credits),
        models: Array.isArray(day.models)
          ? day.models
            .filter((model) => model && (typeof model.id === "string" || typeof model.label === "string"))
            .map((model, index) => ({
              id: typeof model.id === "string" && model.id.trim() ? model.id : `unknown-model-${index}`,
              label: typeof model.label === "string" && model.label.trim()
                ? model.label
                : (typeof model.id === "string" && model.id.trim() ? model.id : "未知模型/档位"),
              credits: numericCredit(model.credits),
            }))
          : [],
      }))
    : [];
  return {
    ...emptyOfficialUsage(range),
    ...value,
    range: typeof value.range === "string" ? value.range : range,
    available: value.available === true,
    totalCredits: numericCredit(value.totalCredits),
    models,
    daily,
  };
}

export function extractOfficialUsageSummary(result, range = "today") {
  const privatePayload = getPrivateToolPayload(result);
  const candidate = privatePayload ?? result?.structuredContent ?? result;
  if (!candidate || typeof candidate !== "object") return null;
  const officialUsage = candidate.officialUsage ?? result?.officialUsage;
  const quota = candidate.quota ?? result?.quota ?? null;
  if (!officialUsage && !quota) return null;
  return {
    officialUsage: normalizeOfficialUsage(officialUsage, range),
    quota: quota && typeof quota === "object" ? quota : null,
  };
}

function officialModelColor(id, index = 0) {
  if (typeof id !== "string" || !id) return MODEL_PALETTE[index % MODEL_PALETTE.length];
  let hash = 0;
  for (let cursor = 0; cursor < id.length; cursor += 1) hash = (hash * 31 + id.charCodeAt(cursor)) >>> 0;
  return MODEL_PALETTE[hash % MODEL_PALETTE.length];
}

export function buildCreditSeries(officialUsage) {
  const source = officialUsage ?? emptyOfficialUsage();
  const models = [...(Array.isArray(source.models) ? source.models : [])];
  const known = new Set(models.map((model) => model.id));
  const daily = Array.isArray(source.daily) ? source.daily : [];
  daily.forEach((day) => (day.models ?? []).forEach((model) => {
    if (!known.has(model.id)) {
      known.add(model.id);
      models.push({ id: model.id, label: model.label, credits: null });
    }
  }));
  const total = numericCredit(source.totalCredits);
  const modelRows = models
    .map((model, index) => ({
      ...model,
      color: officialModelColor(model.id, index),
      tokens: numericCredit(model.credits),
      share: total && numericCredit(model.credits) !== null ? (model.credits / total) * 100 : 0,
      displayLabel: model.label,
    }))
    .filter((model) => model.tokens !== null || daily.some((day) => day.models.some((item) => item.id === model.id && numericCredit(item.credits) !== null)));
  const points = [];
  daily.forEach((day, dayIndex) => {
    const dayModels = day.models ?? [];
    if (dayModels.length) {
      dayModels.forEach((model) => {
        const credits = numericCredit(model.credits);
        if (credits === null) return;
        points.push({
          x: source.range === "today" ? 0 : day.date,
          label: source.range === "today" ? day.date : day.date,
          seriesId: model.id,
          tokens: credits,
        });
      });
    } else if (numericCredit(day.credits) !== null) {
      const fallbackId = "__official_total__";
      if (!known.has(fallbackId)) {
        known.add(fallbackId);
        modelRows.push({
          id: fallbackId,
          label: "官方总计（未拆分）",
          displayLabel: "官方总计（未拆分）",
          tokens: day.credits,
          credits: day.credits,
          share: total ? (day.credits / total) * 100 : 0,
          color: OTHER_MODEL_COLOR,
        });
      }
      points.push({
        x: source.range === "today" ? 0 : day.date,
        label: source.range === "today" ? day.date : day.date,
        seriesId: fallbackId,
        tokens: day.credits,
        dayIndex,
      });
    }
  });
  return { models: modelRows, points };
}

export function extractConversationDetail(result) {
  const privatePayload = getPrivateToolPayload(result);
  const candidate = privatePayload?.detail
    ?? result?.structuredContent?.detail
    ?? result?.structuredContent
    ?? result?.detail
    ?? result;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.models)) return null;
  return candidate;
}

export function extractConversationUsageTotals(result) {
  const privatePayload = getPrivateToolPayload(result);
  const candidate = privatePayload?.totals
    ?? result?.structuredContent?.totals
    ?? result?.totals
    ?? result?.structuredContent
    ?? result;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return Object.fromEntries(Object.entries(candidate).map(([id, value]) => {
    const tokens = Number(value);
    return [id, Number.isFinite(tokens) && tokens >= 0 ? tokens : 0];
  }));
}

export function conversationTokenLabel(value, loading = false) {
  if (loading || !Number.isFinite(value)) return "—";
  return formatChartTokens(value);
}

export function cacheRateLabel(breakdown) {
  const input = breakdown?.inputTokens;
  const cached = breakdown?.cachedInputTokens;
  if (breakdown?.cacheTokensKnown !== true || !Number.isFinite(input) || input <= 0 || !Number.isFinite(cached) || cached < 0 || cached > input) return "缓存 —";
  return `缓存 ${(cached / input * 100).toFixed(1)}%`;
}

export function extractConversationCacheBreakdowns(result) {
  const privatePayload = getPrivateToolPayload(result);
  const value = privatePayload?.cumulativeBreakdowns
    ?? result?.structuredContent?.cumulativeBreakdowns
    ?? result?.cumulativeBreakdowns;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function CacheRate({ breakdown }) {
  return <small className="cache-rate" title="输入缓存占比 = 缓存输入 Token ÷ 输入 Token，按当前范围汇总计算；不是请求命中率。缺失数据或输入为 0 时显示 —。">{cacheRateLabel(breakdown)}</small>;
}

export function buildConversationUsageRows(detail) {
  const modelById = new Map();
  for (const model of [
    ...(Array.isArray(detail?.models) ? detail.models : []),
    ...(Array.isArray(detail?.credits?.models) ? detail.credits.models : []),
  ]) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
    modelById.set(model.id, { ...(modelById.get(model.id) ?? {}), ...model });
  }
  return [...modelById.values()].map((model) => ({
    id: model.id,
    label: typeof model.label === "string" && model.label.trim() ? model.label : model.id,
    todayTokens: Math.max(0, numericValue(model.todayTokens)),
    cumulativeTokens: Math.max(0, numericValue(model.cumulativeTokens)),
    todayBreakdown: model.todayBreakdown ?? null,
    cumulativeBreakdown: model.cumulativeBreakdown ?? null,
    todayCredits: numericCredit(model.todayCredits),
    cumulativeCredits: numericCredit(model.cumulativeCredits),
    todayShare: Math.max(0, numericValue(model.todayShare)),
    cumulativeShare: Math.max(0, numericValue(model.cumulativeShare)),
  }));
}

export function comparisonBarWidth(value, maximum) {
  const amount = Math.max(0, numericValue(value));
  const scale = Math.max(0, numericValue(maximum));
  if (!scale) return 0;
  return Math.max(0, Math.min(100, (amount / scale) * 100));
}

export function comparisonBarStyle(value, maximum) {
  const amount = Math.max(0, numericValue(value));
  const scale = Math.max(0, numericValue(maximum));
  return {
    width: `${comparisonBarWidth(amount, scale)}%`,
    minWidth: amount > 0 && scale > 0 ? "2px" : "0px",
  };
}

const CHART_PLOT = Object.freeze({ left: 44, right: 12, top: 18, bottom: 48 });
const MODEL_PALETTE = ["#2866F7", "#8B6DFF", "#4A9AF4", "#B27CF5", "#38AE93", "#E29A49"];

function chartPointKey(point) {
  return `${typeof point?.x}:${String(point?.x)}`;
}

const OTHER_MODEL_ID = "__other_model_effort__";
const OTHER_MODEL_LABEL = "其他模型/档位";
const OTHER_MODEL_COLOR = "#9299A8";
const MODEL_BREAKDOWN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
];

function numericValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function addModelBreakdown(target, source) {
  for (const field of MODEL_BREAKDOWN_FIELDS) {
    target[field] += numericValue(source?.[field]);
  }
}

/**
 * Keep the chart and its companion breakdown legible when an all-time
 * snapshot contains many model/effort combinations. The first four entries
 * retain their identity; every remaining entry is represented by one stable
 * aggregate series whose tokens, share and time buckets are summed. This keeps
 * the companion model panel at five rows maximum, including the aggregate.
 */
export function compressModelSeries(models = [], points = []) {
  if (!Array.isArray(models) || models.length <= 5) return { models, points };

  const rankedModels = [...models].sort((first, second) => (
    numericValue(second?.tokens) - numericValue(first?.tokens)
  ));
  const retainedModels = rankedModels.slice(0, 4);
  const retainedIds = new Set(retainedModels.map((model) => model.id));
  const otherModels = rankedModels.slice(4);
  const otherBreakdown = Object.fromEntries(MODEL_BREAKDOWN_FIELDS.map((field) => [field, 0]));
  let otherTokens = 0;
  let otherShare = 0;
  for (const model of otherModels) {
    otherTokens += numericValue(model?.tokens);
    otherShare += numericValue(model?.share);
    addModelBreakdown(otherBreakdown, model?.breakdown);
  }

  const fallbackTokens = new Map();
  const otherBuckets = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    if (retainedIds.has(point?.seriesId)) continue;
    const pointKey = chartPointKey(point);
    if (!otherBuckets.has(pointKey)) {
      otherBuckets.set(pointKey, {
        x: point.x,
        label: point.label ?? String(point.x),
        seriesId: OTHER_MODEL_ID,
        tokens: 0,
        isPeak: false,
      });
    }
    const bucket = otherBuckets.get(pointKey);
    bucket.tokens += numericValue(point.tokens);
    fallbackTokens.set(point.seriesId, (fallbackTokens.get(point.seriesId) ?? 0) + numericValue(point.tokens));
  }

  // A malformed/legacy model payload may omit its total; retain the chart's
  // aggregate as the fallback so the "other" series never loses usage.
  if (!otherTokens) {
    otherTokens = otherModels.reduce(
      (total, model) => total + (fallbackTokens.get(model?.id) ?? 0),
      0,
    );
  }
  if (!otherShare) {
    const totalTokens = rankedModels.reduce((total, model) => total + numericValue(model?.tokens), 0);
    otherShare = totalTokens ? (otherTokens / totalTokens) * 100 : 0;
  }

  const otherModel = {
    id: OTHER_MODEL_ID,
    model: "other",
    effort: "other",
    label: OTHER_MODEL_LABEL,
    displayLabel: OTHER_MODEL_LABEL,
    color: OTHER_MODEL_COLOR,
    tokens: otherTokens,
    share: otherShare,
    breakdown: otherBreakdown,
    isOther: true,
  };
  const retainedPoints = (Array.isArray(points) ? points : [])
    .filter((point) => retainedIds.has(point?.seriesId));
  return {
    models: [...retainedModels, otherModel],
    points: [...retainedPoints, ...otherBuckets.values()],
  };
}

export function aggregateChartSummaries(points = [], models = [], hiddenSeries = new Set()) {
  const hidden = hiddenSeries instanceof Set ? hiddenSeries : new Set(hiddenSeries ?? []);
  const visibleModels = models.filter((model) => !hidden.has(model.id));
  const visibleIds = new Set(visibleModels.map((model) => model.id));
  const buckets = new Map();

  for (const point of points) {
    if (!visibleIds.has(point?.seriesId)) continue;
    const key = chartPointKey(point);
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        x: point.x,
        label: point.label ?? String(point.x),
        totalTokens: 0,
        seriesTokens: new Map(),
      });
    }
    const bucket = buckets.get(key);
    const tokens = Number.isFinite(point.tokens) ? point.tokens : 0;
    bucket.totalTokens += tokens;
    bucket.seriesTokens.set(point.seriesId, (bucket.seriesTokens.get(point.seriesId) ?? 0) + tokens);
  }

  return [...buckets.values()].map((bucket) => ({
    key: bucket.key,
    x: bucket.x,
    label: bucket.label,
    totalTokens: bucket.totalTokens,
    series: visibleModels.map((model) => ({
      id: model.id,
      label: model.displayLabel ?? model.label ?? String(model.id),
      color: model.color ?? MODEL_PALETTE[0],
      tokens: bucket.seriesTokens.get(model.id) ?? 0,
    })),
  }));
}

/**
 * Return the centre of a categorical (band) chart slot as a 0..1 ratio.
 *
 * The G2 chart uses a band scale with inner/outer padding. Using a plain
 * `index / (count - 1)` ratio puts the crosshair on the plot edges and,
 * consequently, between bars. Keep the positioning math in one place so
 * the hover target, crosshair and portal tooltip share the same anchor.
 */
export function bandCenterPosition(index, count, paddingInner = 0.2, paddingOuter = 0.08) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount) return 0;
  const safeIndex = Math.max(0, Math.min(safeCount - 1, Number(index) || 0));
  const inner = Math.max(0, Math.min(1, Number(paddingInner) || 0));
  const outer = Math.max(0, Number(paddingOuter) || 0);
  // Equivalent to a d3/G2 band scale over a normalized [0, 1] range.
  const step = 1 / Math.max(1, safeCount - inner + outer * 2);
  const start = (1 - step * (safeCount - inner)) / 2;
  return Math.max(0, Math.min(1, start + step * safeIndex + (step * (1 - inner)) / 2));
}

export function chartPointPosition(summary, index, count, range = "today") {
  const paddingInner = range === "today" ? 0.28 : 0.2;
  // `index` is the categorical position used by G2's x-domain. The source
  // x value is intentionally not used here: sparse test data and future
  // server buckets can have non-contiguous labels while the rendered bars
  // still occupy consecutive band slots.
  return bandCenterPosition(index, count, paddingInner, 0.08);
}

export function nonZeroChartSeries(series = []) {
  return (Array.isArray(series) ? series : []).filter(
    (item) => Number.isFinite(item?.tokens) && item.tokens > 0,
  );
}

export function nearestChartSummary(summaries, normalizedPosition, range = "today") {
  if (!Array.isArray(summaries) || !summaries.length || !Number.isFinite(normalizedPosition)) return null;
  if (normalizedPosition < 0 || normalizedPosition > 1) return null;
  return summaries.reduce((nearest, summary, index) => {
    const distance = Math.abs(chartPointPosition(summary, index, summaries.length, range) - normalizedPosition);
    if (!nearest || distance < nearest.distance) return { summary, distance };
    return nearest;
  }, null)?.summary ?? null;
}

export function nextChartSelection(summary) {
  return summary?.key ?? null;
}

export function formatChartTokens(value) {
  if (!Number.isFinite(value)) return "—";
  return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 万`;
}

export function clampTooltipPosition({
  anchorX,
  anchorY,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 12,
  gap = 12,
}) {
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const safeViewportWidth = Math.max(safeWidth + margin * 2, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(safeHeight + margin * 2, Number(viewportHeight) || 0);
  const maxLeft = Math.max(margin, safeViewportWidth - safeWidth - margin);
  const left = Math.min(maxLeft, Math.max(margin, (Number(anchorX) || 0) - safeWidth / 2));
  const above = (Number(anchorY) || 0) - gap - safeHeight;
  const below = (Number(anchorY) || 0) + gap;
  const maxTop = Math.max(margin, safeViewportHeight - safeHeight - margin);
  if (above >= margin) return { left, top: above, placement: "above" };
  if (below <= maxTop) return { left, top: below, placement: "below" };
  return {
    left,
    top: Math.min(maxTop, Math.max(margin, above)),
    placement: above >= margin ? "above" : "clamped",
  };
}

function ChartSummaryCard({ summary, pinned, anchor, onClose, metric = "tokens" }) {
  const cardRef = useRef(null);
  const [placement, setPlacement] = useState(null);

  useLayoutEffect(() => {
    setPlacement(null);
    if (!summary || !anchor || !cardRef.current || typeof window === "undefined") return undefined;
    const rect = cardRef.current.getBoundingClientRect();
    setPlacement(clampTooltipPosition({
      anchorX: anchor.x,
      anchorY: anchor.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
    return undefined;
  }, [summary, anchor]);

  if (!summary) return null;
  const visibleSeries = nonZeroChartSeries(summary.series);

  const card = (
    <div
      ref={cardRef}
      id="chart-summary"
      className={`chart-summary-card${pinned ? " is-pinned" : ""}`}
      style={{
        left: placement ? `${placement.left}px` : `${Math.max(12, anchor?.x ?? 12)}px`,
        top: placement ? `${placement.top}px` : `${Math.max(12, anchor?.y ?? 12)}px`,
        visibility: placement ? "visible" : "hidden",
      }}
      role={pinned ? "status" : "tooltip"}
      aria-live={pinned ? "polite" : undefined}
    >
      <div className="chart-summary-head">
        <div>
          <span className="chart-summary-time">{summary.label}</span>
          <strong>{formatMetricValue(summary.totalTokens, metric)} {metric === "tokens" ? "万 Token" : "Credits"}</strong>
        </div>
        {pinned && (
          <button type="button" className="chart-summary-close" aria-label="关闭趋势摘要" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        )}
      </div>
      <ul className="chart-summary-series">
        {visibleSeries.map((series) => (
          <li key={series.id}>
            <span><i style={{ backgroundColor: series.color }} />{series.label}</span>
            <strong>{formatMetricValue(series.tokens, metric)}{metric === "tokens" ? " 万" : ""}</strong>
          </li>
        ))}
        {!visibleSeries.length && <li className="chart-summary-empty">该时段暂无消耗</li>}
      </ul>
      {!pinned && <small className="chart-summary-hint">点击固定 · Esc 关闭</small>}
    </div>
  );
  return typeof document === "undefined" ? card : createPortal(card, document.body);
}

function UsageChart({ points, models, hiddenSeries, range, loading, metric = "tokens" }) {
  const containerRef = useRef(null);
  const visiblePoints = points.filter((point) => !hiddenSeries.has(point.seriesId));
  const yMaximum = metric === "credits"
    ? niceValueMaximum(visiblePoints)
    : niceTokenMaximum(visiblePoints);
  const summaries = useMemo(
    () => aggregateChartSummaries(points, models, hiddenSeries),
    [points, models, hiddenSeries],
  );
  const [hoveredPointKey, setHoveredPointKey] = useState(null);
  const [pinnedPointKey, setPinnedPointKey] = useState(null);
  const [chartLayoutVersion, setChartLayoutVersion] = useState(0);
  const activePointKey = pinnedPointKey ?? hoveredPointKey;
  const activeSummary = summaries.find((summary) => summary.key === activePointKey) ?? null;
  const activeIndex = activeSummary ? summaries.findIndex((summary) => summary.key === activeSummary.key) : -1;
  const activePosition = activeSummary
    ? chartPointPosition(activeSummary, activeIndex, summaries.length, range)
    : 0;
  const activeAnchor = useMemo(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !activeSummary) return null;
    const plotWidth = Math.max(0, rect.width - CHART_PLOT.left - CHART_PLOT.right);
    const plotHeight = Math.max(0, rect.height - CHART_PLOT.top - CHART_PLOT.bottom);
    const valueRatio = Math.max(0, Math.min(1, activeSummary.totalTokens / Math.max(1, yMaximum)));
    return {
      x: rect.left + CHART_PLOT.left + plotWidth * activePosition,
      y: rect.top + CHART_PLOT.top + plotHeight * (1 - valueRatio),
    };
  }, [activeSummary, activePosition, yMaximum, chartLayoutVersion]);

  useEffect(() => {
    if (pinnedPointKey && !summaries.some((summary) => summary.key === pinnedPointKey)) setPinnedPointKey(null);
    if (hoveredPointKey && !summaries.some((summary) => summary.key === hoveredPointKey)) setHoveredPointKey(null);
  }, [summaries, pinnedPointKey, hoveredPointKey]);

  useEffect(() => {
    if (!activeSummary || typeof window === "undefined") return undefined;
    const updateTooltipAnchor = () => setChartLayoutVersion((version) => version + 1);
    window.addEventListener("resize", updateTooltipAnchor);
    window.addEventListener("scroll", updateTooltipAnchor, true);
    return () => {
      window.removeEventListener("resize", updateTooltipAnchor);
      window.removeEventListener("scroll", updateTooltipAnchor, true);
    };
  }, [activeSummary]);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const visibleModels = models.filter((model) => !hiddenSeries.has(model.id));
    const visibleIds = new Set(visibleModels.map((model) => model.id));
    // Interval marks require a band scale on x. Keep the source x value for
    // summaries/keyboard navigation, but give G2 a stable categorical key so
    // each hour/day can receive a real bar instead of collapsing on y=0.
    const chartData = points
      .filter((point) => visibleIds.has(point.seriesId))
      .map((point) => ({ ...point, chartX: String(point.x) }));
    const data = chartData.filter((point) => Number.isFinite(point.tokens) && point.tokens > 0);
    const chartXDomain = [...new Set(chartData.map((point) => point.chartX))];
    const chart = new Chart({
      container: containerRef.current,
      autoFit: true,
      margin: 0,
      inset: 0,
      height: Math.max(210, containerRef.current.clientHeight || 317),
      paddingLeft: CHART_PLOT.left,
      paddingRight: CHART_PLOT.right,
      paddingTop: CHART_PLOT.top,
      paddingBottom: CHART_PLOT.bottom,
      // The dashboard owns the hover/click summary. G2's inferred tooltip
      // would otherwise render a second, overlapping detail panel.
      interaction: { tooltip: false },
    });

    chart.scale("x", {
      type: "band",
      domain: chartXDomain,
      paddingInner: range === "today" ? 0.28 : 0.2,
      paddingOuter: 0.08,
    });
    chart.scale("y", { domain: [0, yMaximum], nice: true, zero: true, tickCount: 7 });
    chart.scale("color", {
      domain: visibleModels.map((model) => model.id),
      range: visibleModels.map((model) => model.color),
    });
    chart.axis("x", {
      title: false,
      tick: false,
      line: true,
      lineStroke: "#d9dee8",
      grid: true,
      gridStroke: "#e0e5ed",
      gridLineDash: [3, 5],
      labelAutoHide: true,
      labelAutoRotate: false,
      labelFill: "#737c8c",
      labelFontSize: 12,
      labelFormatter: (value) => {
        const index = chartXDomain.indexOf(String(value));
        const capacity = Math.max(4, Math.floor((containerRef.current?.clientWidth || 800) / 70));
        const stride = Math.max(1, Math.ceil(chartXDomain.length / capacity));
        if (index >= 0 && index % stride !== 0) return "";
        if (metric === "credits") {
          if (range === "today") return "今天";
          const date = new Date(`${String(value)}T00:00:00`);
          if (!Number.isNaN(date.getTime())) return `${date.getMonth() + 1}/${date.getDate()}`;
          return String(value);
        }
        if (range === "all") {
          const [, month] = String(value).split("-");
          return month ? `${Number(month)}月` : String(value);
        }
        if (range !== "today") return String(value);
        const hour = Number(value);
        return `${String(Math.round(hour)).padStart(2, "0")}:00`;
      },
    });
    chart.axis("y", {
      title: false,
      tick: false,
      line: false,
      grid: true,
      gridStroke: "#e0e5ed",
      gridLineDash: [3, 5],
      labelFill: "#737c8c",
      labelFontSize: 12,
      labelFormatter: (value) => {
        const numeric = Number(value);
        if (numeric >= yMaximum) return "";
        if (numeric === 0) return "0";
        return metric === "credits"
          ? formatCreditsShort(numeric)
          : Math.round(numeric / 10_000).toLocaleString("zh-CN");
      },
    });
    chart.legend("color", false);

    chart
      .interval()
      .data(data)
      .encode("x", "chartX")
      .encode("y", "tokens")
      .encode("color", "seriesId")
      .transform({ type: "stackY" })
      .style("fillOpacity", 0.8)
      .style("inset", 2)
      .style("radiusTopLeft", 3)
      .style("radiusTopRight", 3);

    let disposed = false;
    chart.render();

    // The dashboard changes the chart's available height when its compact
    // sections settle (and again when the native host resizes). G2's
    // `autoFit` only follows window resize, so observe the actual host and
    // keep both dimensions in sync with the canvas.
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        if (disposed || !containerRef.current) return;
        const width = containerRef.current.clientWidth;
        const height = Math.max(210, containerRef.current.clientHeight || 317);
        if (width > 0 && height > 0) chart.changeSize(width, height);
      });
    resizeObserver?.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chart.destroy();
    };
  }, [points, models, hiddenSeries, range, yMaximum, metric]);

  function summaryFromPointer(event) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (
      x < CHART_PLOT.left
      || x > rect.width - CHART_PLOT.right
      || y < CHART_PLOT.top
      || y > rect.height - CHART_PLOT.bottom
    ) return null;
    const normalizedPosition = (x - CHART_PLOT.left) / (rect.width - CHART_PLOT.left - CHART_PLOT.right);
    return nearestChartSummary(summaries, normalizedPosition, range);
  }

  function handlePointerMove(event) {
    if (event.pointerType === "touch") return;
    setHoveredPointKey(summaryFromPointer(event)?.key ?? null);
  }

  function handlePointerLeave() {
    setHoveredPointKey(null);
  }

  function handleChartClick(event) {
    const summary = summaryFromPointer(event);
    const nextKey = nextChartSelection(summary);
    setHoveredPointKey(nextKey);
    setPinnedPointKey(nextKey);
  }

  function handleStageClick(event) {
    if (!event.target.closest?.(".g2-chart, .chart-summary-card, .chart-point-select")) {
      setHoveredPointKey(null);
      setPinnedPointKey(null);
    }
  }

  function handleChartKeyDown(event) {
    if (event.key === "Escape") {
      setHoveredPointKey(null);
      setPinnedPointKey(null);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!summaries.length) return;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const foundIndex = summaries.findIndex((summary) => summary.key === (hoveredPointKey ?? pinnedPointKey));
      const currentIndex = foundIndex >= 0 ? foundIndex : direction > 0 ? -1 : 0;
      const nextIndex = (currentIndex + direction + summaries.length) % summaries.length;
      setHoveredPointKey(summaries[nextIndex].key);
      return;
    }
    if (hoveredPointKey) setPinnedPointKey(hoveredPointKey);
  }

  function selectSummary(event) {
    const key = event.target.value || null;
    setHoveredPointKey(key);
    setPinnedPointKey(nextChartSelection(summaries.find((summary) => summary.key === key)));
  }

  return (
    <div className="chart-stage" aria-label="按模型和思考档位统计的 Token 趋势图" onClick={handleStageClick}>
      <div className="chart-unit">{metric === "credits" ? "Credits" : "Token（万）"}</div>
      <select
        className="chart-point-select"
        aria-label="选择趋势时间点"
        value={pinnedPointKey ?? ""}
        onChange={selectSummary}
        disabled={!summaries.length}
      >
        <option value="">选择时间点</option>
        {summaries.map((summary) => (
          <option value={summary.key} key={summary.key}>{summary.label} · {formatMetricValue(summary.totalTokens, metric)}{metric === "tokens" ? " 万" : ""}</option>
        ))}
      </select>
      <div
        ref={containerRef}
        className="g2-chart"
        role="img"
        tabIndex={0}
        aria-label="Token 趋势图。使用左右方向键浏览时间点，回车固定摘要，Esc 关闭摘要。"
        aria-describedby={activeSummary ? "chart-summary" : undefined}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleChartClick}
        onKeyDown={handleChartKeyDown}
      />
      {activeSummary && (
        <>
          <div className="chart-crosshair" style={{ left: `calc(${CHART_PLOT.left}px + (100% - ${CHART_PLOT.left + CHART_PLOT.right}px) * ${activePosition})` }} aria-hidden="true">
            {activeSummary.series.filter((series) => series.tokens > 0).map((series) => {
              const verticalRatio = 1 - Math.max(0, Math.min(1, series.tokens / yMaximum));
              return <i key={series.id} style={{ top: `calc(${verticalRatio * 100}% - 4px)`, backgroundColor: series.color }} />;
            })}
          </div>
          <ChartSummaryCard
            summary={activeSummary}
            pinned={Boolean(pinnedPointKey)}
            anchor={activeAnchor}
            metric={metric}
            onClose={() => {
              setHoveredPointKey(null);
              setPinnedPointKey(null);
            }}
          />
        </>
      )}
      {!points.length && (
        <div className="chart-empty">
          {loading
            ? `正在读取${metricUnit(metric)}…`
            : metric === "credits"
              ? "官方 Credits 暂不可用"
              : range === "all" ? "暂无可归因的历史 Token" : "当前周期暂无可归因 Token"}
        </div>
      )}
    </div>
  );
}

export function compactModelBreakdownModels(models, maxVisible = 5) {
  if (!Array.isArray(models) || models.length <= maxVisible) return models;
  const ranked = [...models].sort((first, second) => (
    numericValue(second?.tokens) - numericValue(first?.tokens)
  ));
  const retained = ranked.slice(0, Math.max(1, maxVisible - 1));
  const omitted = ranked.slice(Math.max(1, maxVisible - 1));
  const omittedTokens = omitted.reduce((total, model) => total + numericValue(model?.tokens), 0);
  const omittedShare = omitted.reduce((total, model) => total + numericValue(model?.share), 0);
  return [
    ...retained,
    {
      id: "__model-breakdown-other__",
      label: "其他模型/档位",
      displayLabel: "其他模型/档位",
      color: OTHER_MODEL_COLOR,
      tokens: omittedTokens,
      share: omittedShare,
      isOther: true,
    },
  ];
}

function ModelBreakdown({ models, loading, metric = "tokens" }) {
  const visibleModels = useMemo(() => models.filter((model) => model.tokens > 0), [models]);
  const maximumTokens = Math.max(1, ...visibleModels.map((model) => model.tokens));
  return (
    <aside className="model-breakdown" aria-labelledby="model-breakdown-title">
      <div className="panel-kicker">按 {metricUnit(metric)} 用量</div>
      <h2 id="model-breakdown-title">模型用量</h2>
      {!visibleModels.length ? (
        <div className="model-empty">{loading ? "正在归并模型…" : "当前周期暂无模型数据"}</div>
      ) : (
        <div className="model-list">
          {visibleModels.map((model) => (
            <button
              type="button"
              className={`model-item ${model.isMuted ? "is-muted" : ""}`}
              key={model.id}
              onClick={model.isOther ? undefined : model.onToggle}
              disabled={model.isOther}
              aria-disabled={model.isOther ? "true" : undefined}
              aria-pressed={model.isOther ? undefined : !model.isMuted}
            >
              <div className="model-item-head">
                <span className="model-item-label" style={{ color: model.color }}>
                  {model.displayLabel ?? model.label}
                </span>
                <span className="token-with-cache"><strong>{metric === "tokens" ? formatChartTokens(model.tokens) : formatMetricValue(model.tokens, metric)}</strong>{metric === "tokens" && <CacheRate breakdown={model.breakdown} />}</span>
              </div>
              <div className="model-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, model.tokens / maximumTokens * 100))}%`, backgroundColor: model.color }} />
              </div>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

function TaskProgress({ task, range = "today" }) {
  const progress = task.progress;
  if (task.statusKind === "completed" || task.status === "本轮完成") {
    return (
      <span className="task-progress task-progress-complete">
        <span>本轮完成</span>
        <CheckCircle size={16} weight="fill" />
      </span>
    );
  }
  if (progress?.kind === "steps" && progress.totalSteps > 0) {
    const percent = Math.max(0, Math.min(100, (progress.completedSteps / progress.totalSteps) * 100));
    return (
      <span className="task-progress task-progress-steps">
        <span>{progress.label}</span>
        <span className="step-progress-bar" aria-label={`已完成 ${progress.label}`}>
          <i style={{ width: `${percent}%` }} />
        </span>
      </span>
    );
  }
  return (
    <span className="task-progress task-progress-active">
      <i />
      <span>{task.status ?? (range === "today" ? "今日活跃" : "活跃")}</span>
      <small>{task.updatedAtLabel ? `${task.updatedAtLabel} 更新` : ""}</small>
    </span>
  );
}

function ConversationDetails({ conversation, onOpenDetail }) {
  return (
    <div className="conversation-details">
      <div className="detail-facts">
        <span>{conversation.toolCalls} 次工具调用</span>
        <i />
        <span>{conversation.analysisDurationLabel ?? conversation.durationLabel}</span>
        <i />
        <span>{conversation.updatedAtLabel ? `${conversation.updatedAtLabel} 更新` : "更新时间未知"}</span>
        <i />
        <span>{conversation.projectLabel ?? "未识别项目"}</span>
      </div>
      <button type="button" className="detail-link" onClick={onOpenDetail}>
        查看详情 <ArrowRight size={16} weight="bold" />
      </button>
    </div>
  );
}

function ConversationRow({ conversation, selected, onSelect, onOpenDetail, range, cumulativeTokens, cumulativeBreakdown, cumulativeLoading }) {
  const projectLabel = conversation.projectLabel ?? "未识别项目";
  const rangeClass = range === "all" ? "is-all-range" : "has-cumulative-range";
  return (
    <article className={`conversation-row ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className={`conversation-trigger ${rangeClass}`}
        onClick={() => onSelect(conversation.id)}
        aria-expanded={selected}
      >
        <span className="task-icon" aria-hidden="true">
          <ChatCircleDots size={19} weight="duotone" />
        </span>
        <span className="conversation-copy">
          <strong title={conversation.title}>{conversation.title}</strong>
          <small className="task-project-subline" title={projectLabel}>{projectLabel}</small>
        </span>
        <span className="task-progress-cell">
          <TaskProgress task={conversation} range={range} />
        </span>
        <span className="conversation-token token-with-cache">{formatChartTokens(conversation.tokens)}<CacheRate breakdown={conversation.breakdown} /></span>
        {range !== "all" && (
          <span className="conversation-cumulative-token">
            {conversationTokenLabel(cumulativeTokens, cumulativeLoading)}
            <CacheRate breakdown={cumulativeLoading ? null : cumulativeBreakdown} />
          </span>
        )}
        <CaretDown className="row-caret" size={15} weight="bold" />
      </button>
      {selected && (
        <ConversationDetails
          conversation={conversation}
          onOpenDetail={() => onOpenDetail(conversation)}
        />
      )}
    </article>
  );
}

function DetailDialog({ conversation, detail, loading, error, onClose }) {
  const dialogRef = useRef(null);
  const dragRef = useRef(null);
  const [dialogPosition, setDialogPosition] = useState({ x: 0, y: 0 });
  const dialogPositionRef = useRef(dialogPosition);
  const [isDragging, setIsDragging] = useState(false);
  const [detailMetric, setDetailMetric] = useState("tokens");

  useEffect(() => {
    dialogPositionRef.current = dialogPosition;
  }, [dialogPosition]);

  useEffect(() => {
    const initialPosition = { x: 0, y: 0 };
    dialogPositionRef.current = initialPosition;
    setDialogPosition(initialPosition);
    dragRef.current = null;
    setIsDragging(false);
    setDetailMetric("tokens");
  }, [conversation?.id]);

  function clampDialogPosition(nextPosition, drag) {
    if (typeof window === "undefined") return nextPosition;
    const margin = 16;
    const baseLeft = drag.originRect.left - drag.originPosition.x;
    const baseTop = drag.originRect.top - drag.originPosition.y;
    const minX = margin - baseLeft;
    const maxX = Math.max(minX, window.innerWidth - margin - drag.originRect.width - baseLeft);
    const minY = margin - baseTop;
    const maxY = Math.max(minY, window.innerHeight - margin - drag.originRect.height - baseTop);
    return {
      x: Math.min(maxX, Math.max(minX, nextPosition.x)),
      y: Math.min(maxY, Math.max(minY, nextPosition.y)),
    };
  }

  function handleDragStart(event) {
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originRect: dialog.getBoundingClientRect(),
      originPosition: dialogPositionRef.current,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleDragMove(event) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const nextPosition = clampDialogPosition({
      x: drag.originPosition.x + event.clientX - drag.startX,
      y: drag.originPosition.y + event.clientY - drag.startY,
    }, drag);
    dialogPositionRef.current = nextPosition;
    setDialogPosition(nextPosition);
  }

  function handleDragEnd(event) {
    const drag = dragRef.current;
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    if (event.currentTarget.hasPointerCapture?.(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  }

  if (!conversation) return null;
  const detailConversation = detail?.conversation ?? conversation;
  const rows = buildConversationUsageRows(detail);
  const detailCredits = detail?.credits ?? null;
  const maximum = Math.max(
    ...rows.map((row) => detailMetric === "credits"
      ? Math.max(numericValue(row.todayCredits), numericValue(row.cumulativeCredits))
      : Math.max(row.todayTokens, row.cumulativeTokens)),
    0,
  );
  const todayTokens = detail ? detail.todayTokens : null;
  const cumulativeTokens = detail ? detail.cumulativeTokens : null;
  const todayCredits = detailCredits ? numericCredit(detailCredits.todayCredits) : null;
  const cumulativeCredits = detailCredits ? numericCredit(detailCredits.cumulativeCredits) : null;
  const hasCreditRows = rows.some((row) => row.todayCredits !== null || row.cumulativeCredits !== null);
  const metricTotal = rows.reduce((total, row) => total + (detailMetric === "credits"
    ? numericValue(row.cumulativeCredits)
    : numericValue(row.cumulativeTokens)), 0);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        aria-busy={loading}
        style={{ transform: `translate3d(${dialogPosition.x}px, ${dialogPosition.y}px, 0)` }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="dialog-close" aria-label="关闭详情" onClick={onClose}>
          <X size={18} />
        </button>
        <div
          className={`dialog-drag-handle${isDragging ? " is-dragging" : ""}`}
          title="拖拽移动详情弹窗"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onLostPointerCapture={handleDragEnd}
        >
          <p>任务用量明细</p>
          <h2 id="detail-title">{detailConversation.title ?? conversation.title}</h2>
        </div>
        <div className="dialog-metrics">
          <div>
            <span>今日 Token</span>
            <strong className="token-with-cache">{formatCompactTokens(todayTokens)}<CacheRate breakdown={detail?.todayBreakdown} /></strong>
          </div>
          <div>
            <span>本机累计 Token</span>
            <strong className="token-with-cache">{formatCompactTokens(cumulativeTokens)}<CacheRate breakdown={detail?.cumulativeBreakdown} /></strong>
          </div>
          {todayCredits !== null && <div className="dialog-metric-credit">
            <span>今日 credits</span>
            <strong>{formatCredits(todayCredits)}</strong>
          </div>}
          {cumulativeCredits !== null && <div className="dialog-metric-credit">
            <span>累计 credits（官方估计）</span>
            <strong>{formatCredits(cumulativeCredits)}</strong>
          </div>}
        </div>

        {loading && <div className="detail-state" role="status">正在读取今日与本机累计明细…</div>}
        {!loading && error && <div className="detail-state detail-state-error" role="alert">{error}</div>}
        {!loading && !error && !rows.length && (
          <div className="detail-state">暂无可归因的模型与思考档位数据</div>
        )}
        {!loading && !error && rows.length > 0 && (
          <section className="usage-comparison" aria-label="今日与本机累计模型用量对比">
            <div className="usage-comparison-heading">
              <div>
                <span className="dialog-section-kicker">模型 × 思考档位</span>
                <strong>{detailMetric === "credits" ? "Credits 今日与累计用量" : "Token 今日与累计用量"}</strong>
              </div>
              <div className="usage-comparison-tools">
                {hasCreditRows && <div className="detail-metric-toggle" role="group" aria-label="详情指标">
                  <button type="button" className={detailMetric === "tokens" ? "is-active" : ""} onClick={() => setDetailMetric("tokens")}>Token</button>
                  <button type="button" className={detailMetric === "credits" ? "is-active" : ""} onClick={() => setDetailMetric("credits")}>Credits</button>
                </div>}
                <div className="usage-comparison-legend" aria-label="图例">
                  <span><i className="legend-swatch legend-swatch-cumulative" />累计</span>
                  <span><i className="legend-swatch legend-swatch-today" />今日</span>
                </div>
              </div>
            </div>
            {detailMetric === "credits" && !hasCreditRows ? (
              <div className="detail-state detail-state-inline">官方 Credits 暂不可用</div>
            ) : (
              <div className="usage-comparison-list">
                {rows.map((row, index) => {
                  const color = officialModelColor(row.id, index);
                  const todayValue = detailMetric === "credits" ? row.todayCredits : row.todayTokens;
                  const cumulativeValue = detailMetric === "credits" ? row.cumulativeCredits : row.cumulativeTokens;
                  const cumulativeStyle = comparisonBarStyle(cumulativeValue, maximum);
                  const todayStyle = comparisonBarStyle(todayValue, maximum);
                  const share = metricTotal > 0 ? (numericValue(cumulativeValue) / metricTotal) * 100 : null;
                  return (
                    <div className="usage-comparison-row" key={row.id}>
                      <div className="usage-comparison-label">
                        <span title={row.label}><i style={{ backgroundColor: color }} />{row.label}</span>
                        {share !== null && <small>{Math.round(share)}%</small>}
                      </div>
                      <div
                        className="usage-comparison-track"
                        aria-label={`${row.label}：今日 ${formatDetailMetric(todayValue, detailMetric)}，累计 ${formatDetailMetric(cumulativeValue, detailMetric)}`}
                      >
                        <span className="usage-comparison-cumulative" style={{ ...cumulativeStyle, backgroundColor: color }} />
                        <span className="usage-comparison-today" style={{ ...todayStyle, backgroundColor: color }} />
                      </div>
                      <div className="usage-comparison-values">
                        <span className="token-with-cache">今日 {formatDetailMetric(todayValue, detailMetric)}{detailMetric === "tokens" && <CacheRate breakdown={row.todayBreakdown} />}</span>
                        <strong className="token-with-cache">累计 {formatDetailMetric(cumulativeValue, detailMetric)}{detailMetric === "tokens" && <CacheRate breakdown={row.cumulativeBreakdown} />}</strong>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <div className="dialog-foot">
          {detailConversation.toolCalls ?? conversation.toolCalls ?? 0} 次工具调用 · {detailConversation.turns ?? conversation.turns ?? 0} 轮 · {detailConversation.childCount ?? conversation.childCount ?? 0} 个子任务 · {detailConversation.projectLabel ?? conversation.projectLabel ?? "未识别项目"}
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [dashboard, setDashboard] = useState(() => getInitialDashboard() ?? emptyDashboardForRange());
  const [range, setRange] = useState(dashboard.range ?? "today");
  const [loading, setLoading] = useState(dashboard.dataSource === "loading");
  const [refreshingRanges, setRefreshingRanges] = useState(() => new Set());
  const nativeWindow = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("native") === "1";
  const initialLoadStarted = useRef(false);
  const initialOfficialLoadStarted = useRef(false);
  const loadRangeRequestRef = useRef(0);
  const dashboardRef = useRef(dashboard);
  const rangeRef = useRef(range);
  const refreshGateRef = useRef(createRangeRefreshGate());
  const refreshing = refreshingRanges.has(range);
  const tasks = Array.isArray(dashboard.tasks) ? dashboard.tasks : (dashboard.conversations ?? []);
  const [selectedConversationId, setSelectedConversationId] = useState(
    () => window.openai?.widgetState?.selectedConversationId ?? null,
  );
  const [hiddenSeries, setHiddenSeries] = useState(new Set());
  const [detailConversation, setDetailConversation] = useState(null);
  const [detailUsage, setDetailUsage] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailRequestRef = useRef(0);
  const detailRetryTimerRef = useRef(null);
  const [officialUsage, setOfficialUsage] = useState(() => emptyOfficialUsage(dashboard.range ?? "today"));
  const [quota, setQuota] = useState(null);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialError, setOfficialError] = useState("");
  const officialRequestRef = useRef(0);
  const [metric, setMetric] = useState("tokens");
  const [cumulativeTokensByConversation, setCumulativeTokensByConversation] = useState({});
  const [cumulativeBreakdownsByConversation, setCumulativeBreakdownsByConversation] = useState({});
  const [cumulativeTokensLoading, setCumulativeTokensLoading] = useState(false);
  const cumulativeTokensRequestRef = useRef(0);
  const [notice, setNotice] = useState("");

  useEffect(() => subscribeToToolResults((result) => {
    const next = extractDashboard(result);
    if (!next) return;
    const nextRange = normalizeDashboardRange(next.range);
    if (rangeRef.current !== nextRange) return;
    dashboardRef.current = next;
    setDashboard(next);
    setRange(nextRange);
    setLoading(false);
  }), []);

  useEffect(() => {
    dashboardRef.current = dashboard;
  }, [dashboard]);

  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  useEffect(() => {
    if (dashboard.dataSource !== "loading" || initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void loadRange(dashboard.range ?? "today");
  }, []);

  useEffect(() => {
    if (initialOfficialLoadStarted.current) return;
    initialOfficialLoadStarted.current = true;
    void loadOfficialRange(rangeRef.current);
  }, []);

  useEffect(() => {
    const refreshVisibleDashboard = () => {
      if (document.visibilityState === "hidden") return;
      void autoRefreshIfStale(dashboardRef.current, rangeRef.current);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshVisibleDashboard();
    };

    window.addEventListener("focus", refreshVisibleDashboard);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", refreshVisibleDashboard);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (tasks.some((item) => item.id === selectedConversationId)) return;
    if (selectedConversationId !== null) setSelectedConversationId(null);
  }, [tasks, selectedConversationId]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedConversation = useMemo(
    () => tasks.find((item) => item.id === selectedConversationId),
    [tasks, selectedConversationId],
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);
  const filteredTasks = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return tasks;
    return tasks.filter((task) => [task.title, task.projectLabel, task.status]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(needle));
  }, [tasks, searchQuery]);

  useEffect(() => {
    setShowAllTasks(false);
  }, [range]);

  const displayedTasks = searchQuery.trim() || showAllTasks ? filteredTasks : filteredTasks.slice(0, 6);

  const taskIds = useMemo(() => tasks
    .map((conversation) => conversation?.id)
    .filter((id) => typeof id === "string" && id.trim()), [tasks]);
  const taskIdsKey = taskIds.join("\u0001");

  useEffect(() => {
    const requestId = cumulativeTokensRequestRef.current + 1;
    cumulativeTokensRequestRef.current = requestId;
    setCumulativeBreakdownsByConversation({});

    if (range === "all" || !taskIds.length) {
      setCumulativeTokensByConversation({});
      setCumulativeTokensLoading(false);
      return undefined;
    }

    setCumulativeTokensByConversation({});
    setCumulativeTokensLoading(true);
    const chunks = [];
    for (let index = 0; index < taskIds.length; index += 20) chunks.push(taskIds.slice(index, index + 20));
    void Promise.all(chunks.map((conversationIds) => callTool("get_conversation_usage_totals", { conversationIds })))
      .then((results) => {
        if (requestId !== cumulativeTokensRequestRef.current) return;
        setCumulativeTokensByConversation(Object.assign({}, ...results.map((result) => extractConversationUsageTotals(result) ?? {})));
        setCumulativeBreakdownsByConversation(Object.assign({}, ...results.map(extractConversationCacheBreakdowns)));
      })
      .catch(() => {
        if (requestId !== cumulativeTokensRequestRef.current) return;
        setCumulativeTokensByConversation({});
      })
      .finally(() => {
        if (requestId === cumulativeTokensRequestRef.current) setCumulativeTokensLoading(false);
      });
    return undefined;
  }, [range, taskIdsKey, dashboard.generatedAt]);

  const compressedSeries = useMemo(
    () => ({ models: dashboard.models ?? [], points: dashboard.chart ?? [] }),
    [dashboard.models, dashboard.chart],
  );
  const tokenChartModels = compressedSeries.models.map((model, index) => ({
    ...model,
    color: model.isOther ? OTHER_MODEL_COLOR : officialModelColor(model.id, index),
    isMuted: hiddenSeries.has(model.id),
    onToggle: () => toggleSeries(model.id),
  }));
  const tokenChartPoints = compressedSeries.points;
  const creditSeries = useMemo(() => buildCreditSeries(officialUsage), [officialUsage]);
  const creditChartModels = creditSeries.models.map((model, index) => ({
    ...model,
    color: model.color ?? officialModelColor(model.id, index),
    isMuted: hiddenSeries.has(model.id),
    onToggle: () => toggleSeries(model.id),
  }));
  const activeChartModels = metric === "credits" ? creditChartModels : tokenChartModels;
  const activeChartPoints = metric === "credits" ? creditSeries.points : tokenChartPoints;

  function markRangeRefreshing(targetRange, active) {
    setRefreshingRanges((current) => {
      const next = new Set(current);
      if (active) next.add(targetRange);
      else next.delete(targetRange);
      return next;
    });
  }

  async function loadOfficialRange(targetRange, { force = false } = {}) {
    const selectedRange = normalizeDashboardRange(targetRange);
    const requestId = officialRequestRef.current + 1;
    officialRequestRef.current = requestId;
    setOfficialLoading(true);
    setOfficialError("");
    try {
      const result = await callTool("get_official_usage_summary", { range: selectedRange, force });
      const summary = extractOfficialUsageSummary(result, selectedRange);
      if (!summary) throw new Error("未返回官方用量数据");
      if (requestId !== officialRequestRef.current || rangeRef.current !== selectedRange) return summary;
      setOfficialUsage(summary.officialUsage);
      setQuota(summary.quota);
      if (summary.officialUsage.error && !summary.officialUsage.available) setOfficialError(summary.officialUsage.error);
      return summary;
    } catch (loadError) {
      if (requestId === officialRequestRef.current && rangeRef.current === selectedRange) {
        setOfficialError(loadError instanceof Error ? loadError.message : "官方用量暂不可用");
        setOfficialUsage(emptyOfficialUsage(selectedRange));
      }
      return null;
    } finally {
      if (requestId === officialRequestRef.current) setOfficialLoading(false);
    }
  }

  async function refreshRange(targetRange, { announceSuccess = false } = {}) {
    const selectedRange = normalizeDashboardRange(targetRange);
    markRangeRefreshing(selectedRange, true);
    try {
      const next = await refreshGateRef.current.run(selectedRange, async () => {
        const result = await callTool("refresh_usage_snapshot", { range: selectedRange });
        const refreshed = extractDashboard(result);
        if (!refreshed) throw new Error("未返回使用数据");
        return refreshed;
      });
      if (rangeRef.current === selectedRange) await loadOfficialRange(selectedRange, { force: true });
      if (rangeRef.current === selectedRange) {
        dashboardRef.current = next;
        setDashboard(next);
        if (announceSuccess) setNotice("已刷新本地 Token 与官方额度");
      }
      return next;
    } catch (error) {
      if (rangeRef.current === selectedRange) {
        setNotice(`刷新失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      return null;
    } finally {
      markRangeRefreshing(selectedRange, false);
    }
  }

  function autoRefreshIfStale(candidate, targetRange) {
    if (!candidate || candidate.dataSource === "loading") return null;
    if (!dashboardNeedsRefresh(candidate)) return null;
    return refreshRange(targetRange);
  }

  async function loadRange(nextRange) {
    const selectedRange = normalizeDashboardRange(nextRange);
    const requestId = loadRangeRequestRef.current + 1;
    loadRangeRequestRef.current = requestId;
    rangeRef.current = selectedRange;
    setRange(selectedRange);
    setLoading(true);
    const loadingDashboard = emptyDashboardForRange(selectedRange);
    dashboardRef.current = loadingDashboard;
    setDashboard(loadingDashboard);
    setOfficialUsage(emptyOfficialUsage(selectedRange));
    setQuota(null);
    setOfficialError("");
    setNotice("");
    void loadOfficialRange(selectedRange);
    try {
      const result = await callTool("get_usage_snapshot", { range: selectedRange });
      const next = extractDashboard(result);
      if (requestId !== loadRangeRequestRef.current || rangeRef.current !== selectedRange) return;
      if (next) {
        dashboardRef.current = next;
        setDashboard(next);
        void autoRefreshIfStale(next, selectedRange);
      }
      else throw new Error("未返回使用数据");
    } catch (error) {
      if (requestId !== loadRangeRequestRef.current || rangeRef.current !== selectedRange) return;
      setDashboard(emptyDashboardForRange(selectedRange, "error"));
      setNotice(`数据读取失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      if (requestId === loadRangeRequestRef.current && rangeRef.current === selectedRange) setLoading(false);
    }
  }

  async function refresh() {
    setNotice("");
    await refreshRange(rangeRef.current, { announceSuccess: true });
  }

  function selectConversation(id) {
    const next = id === selectedConversationId ? null : id;
    setSelectedConversationId(next);
    window.openai?.setWidgetState?.({ selectedConversationId: next });
  }

  function toggleSeries(id) {
    setHiddenSeries((current) => toggleModelVisibility(current, id, activeChartModels.length));
  }

  function clearDetailRetry() {
    if (detailRetryTimerRef.current) window.clearTimeout(detailRetryTimerRef.current);
    detailRetryTimerRef.current = null;
  }

  async function requestConversationDetail(conversation, requestId, attempt = 0) {
    try {
      const result = await callTool("get_conversation_usage_detail", { conversationId: conversation.id });
      const detail = extractConversationDetail(result);
      if (requestId !== detailRequestRef.current) return;
      if (!detail) {
        setDetailError("未返回该任务的用量明细");
        setDetailLoading(false);
        return;
      }
      setDetailUsage(detail);
      setDetailLoading(false);
      const pendingCredits = detail.credits?.pending === true;
      if (pendingCredits && attempt < 8) {
        const retryAfterMs = Math.max(250, Number(detail.credits?.retryAfterMs) || 1_500);
        clearDetailRetry();
        detailRetryTimerRef.current = window.setTimeout(() => {
          detailRetryTimerRef.current = null;
          void requestConversationDetail(conversation, requestId, attempt + 1);
        }, retryAfterMs);
      }
    } catch (error) {
      if (requestId !== detailRequestRef.current) return;
      setDetailError(`明细读取失败：${error instanceof Error ? error.message : "未知错误"}`);
      setDetailLoading(false);
    }
  }

  async function openConversationDetail(conversation) {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    clearDetailRetry();
    setDetailConversation(conversation);
    setDetailUsage(null);
    setDetailError("");
    setDetailLoading(true);
    void requestConversationDetail(conversation, requestId);
  }

  function closeConversationDetail() {
    detailRequestRef.current += 1;
    clearDetailRetry();
    setDetailConversation(null);
    setDetailUsage(null);
    setDetailError("");
    setDetailLoading(false);
  }

  const selectedQuota = quota?.selected ?? null;
  const remainingPercent = Number.isFinite(Number(selectedQuota?.remainingPercent))
    ? Math.max(0, Math.min(100, Number(selectedQuota.remainingPercent)))
    : null;
  const resetAtLabel = selectedQuota?.resetsAt ? formatDateTime(selectedQuota.resetsAt * 1000) : "—";
  const officialTotalCredits = officialUsage.available ? officialUsage.totalCredits : null;
  const creditsAvailable = officialUsage.available === true && Number.isFinite(officialTotalCredits);
  const lastUpdatedAt = officialUsage.fetchedAt ?? dashboard.generatedAt;

  useEffect(() => {
    if (!creditsAvailable && metric === "credits") setMetric("tokens");
  }, [creditsAvailable, metric]);

  return (
    <div className={`app-shell${nativeWindow ? " is-native" : ""}`}>
      <div className={`dashboard-window${nativeWindow ? " is-native" : ""}`}>
        <header className="topbar">
          <div className="window-brand">
            <span className="window-dots" aria-hidden="true"><i /><i /><i /></span>
            <div className="brand-lockup">Codex 用量</div>
          </div>
          <nav className="range-tabs" aria-label="统计周期">
            {RANGE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={range === option.id ? "is-active" : ""}
                onClick={() => loadRange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </nav>
          <div className="sync-actions">
            <span className="sync-state">
              {loading || officialLoading
                ? "正在同步…"
                : <><span className="sync-check">✓</span>{lastUpdatedAt ? `已更新 ${formatClock(lastUpdatedAt)}` : "等待同步"}</>}
            </span>
            <button type="button" className="refresh-button" onClick={refresh} disabled={refreshing || loading || officialLoading} aria-label="立即刷新本地数据与官方额度">
              <ArrowClockwise className={refreshing ? "is-spinning" : ""} size={18} weight="regular" />
            </button>
          </div>
        </header>

        <main className="dashboard">
          <section className={`summary-block${creditsAvailable ? "" : " without-credits"}`} aria-label="用量摘要">
            {creditsAvailable && <div className="summary-card summary-card-credits">
              <p>{dashboard.periodLabel} credits</p>
              <h1 id="summary-title">
                <strong>{creditsAvailable ? formatCredits(officialTotalCredits) : "未提供"}</strong>
              </h1>
              <div
                className="summary-meta"
                title={creditsAvailable ? "Codex App Server 已返回账户 credits 用量" : (officialError || "Codex App Server 未返回账户 credits 用量")}
              >
                {creditsAvailable ? "官方返回" : "当前账号未提供"}
              </div>
            </div>}
            <div className="summary-card summary-card-tokens">
              <p>{dashboard.periodLabel} Token</p>
              <h1>
                <strong>{formatWan(dashboard.totals.tokens)}</strong>
                <span>万</span>
              </h1>
              <div className="summary-meta">
                {tasks.length} 个任务 · {dashboard.totals.toolCalls ?? 0} 次工具调用
              </div>
            </div>
            <div className="summary-card summary-card-quota">
              <p>{formatQuotaWindow(selectedQuota?.windowDurationMins)}</p>
              <h1>
                <strong>{remainingPercent === null ? "—" : `${Math.round(remainingPercent)}%`}</strong>
                <span className="quota-meter" aria-label={remainingPercent === null ? "额度剩余未知" : `额度剩余 ${Math.round(remainingPercent)}%`}>
                  <i style={{ width: `${remainingPercent ?? 0}%` }} />
                </span>
              </h1>
              <div className="summary-meta">重置 {resetAtLabel}</div>
            </div>
            <div className="source-note source-note-inline">
              <Info size={15} />
              <span>{creditsAvailable ? "Token 为本机记录 · Credits 为官方用量" : "Token 为本机记录，含缓存输入与子任务"}</span>
            </div>
          </section>

          <section className="insights-grid" aria-label="Token 或 Credits 趋势和模型构成">
            <div className="trend-section">
              <div className="trend-heading">
                <div>
                  <span className="panel-kicker">{range === "today" ? "今日消耗" : `${dashboard.periodLabel}消耗`}</span>
                  <h2>{metric === "credits" ? "Credits 趋势" : "Token 趋势"}</h2>
                </div>
                {creditsAvailable && <div className="metric-toggle" role="group" aria-label="趋势指标">
                  <button type="button" className={metric === "tokens" ? "is-active" : ""} onClick={() => setMetric("tokens")}>Token</button>
                  <button
                    type="button"
                    className={metric === "credits" ? "is-active" : ""}
                    onClick={() => setMetric("credits")}
                    disabled={!creditsAvailable}
                    title={!creditsAvailable ? "Codex App Server 未返回账户 credits 用量" : undefined}
                    aria-label={!creditsAvailable ? "Credits 暂不可用：Codex App Server 未返回账户 credits 用量" : "Credits"}
                  >
                    Credits
                  </button>
                </div>}
              </div>
              <UsageChart
                points={activeChartPoints}
                models={activeChartModels}
                hiddenSeries={hiddenSeries}
                range={range}
                loading={loading || officialLoading}
                metric={metric}
              />
            </div>
            <ModelBreakdown models={activeChartModels} loading={loading || officialLoading} metric={metric} />
          </section>

          <section className="conversation-section" aria-labelledby="conversation-title">
            <div className="conversation-heading">
              <div className="conversation-heading-title">
                <h2 id="conversation-title">{range === "today" ? "今日任务" : range === "all" ? "累计任务" : "活跃任务"}</h2>
                <span className="task-heading-note">按 Token 用量 · 共 {tasks.length} 个</span>
              </div>
              <label className="task-search">
                <MagnifyingGlass size={16} aria-hidden="true" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索任务"
                  aria-label="搜索任务"
                />
              </label>
            </div>
            <div className={`conversation-column-head ${range === "all" ? "is-all-range" : "has-cumulative-range"}`} aria-hidden="true">
              <span className="column-task">任务</span>
              <span className="column-progress">进度</span>
              <span className="column-token-period">
                {range === "today" ? "今日 Token" : range === "all" ? "累计 Token" : "周期 Token"}
              </span>
              {range !== "all" && <span className="column-token-cumulative">累计 Token</span>}
              <span className="column-caret" />
            </div>
            <div className="conversation-list">
              {displayedTasks.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  selected={selectedConversation?.id === conversation.id}
                  onSelect={selectConversation}
                  onOpenDetail={openConversationDetail}
                  range={range}
                  cumulativeTokens={cumulativeTokensByConversation[conversation.id]}
                  cumulativeBreakdown={cumulativeBreakdownsByConversation[conversation.id]}
                  cumulativeLoading={cumulativeTokensLoading}
                />
              ))}
              {!displayedTasks.length && (
                <div className="conversation-empty">
                  {loading
                    ? "正在归并任务与子任务…"
                    : searchQuery.trim()
                      ? "没有匹配的任务"
                    : range === "all" ? "暂未发现可归因的历史任务" : "当前周期暂无可归因任务"}
                </div>
              )}
            </div>
            {!searchQuery.trim() && filteredTasks.length > displayedTasks.length && (
              <button type="button" className="show-all-tasks" onClick={() => setShowAllTasks(true)}>
                查看全部任务 <ArrowRight size={15} weight="bold" />
              </button>
            )}
          </section>

          <footer className="dashboard-footer">
            注：本地归因基于可观测事件推断，仅供参考，不构成官方计费或任务完成度。
          </footer>
          {notice && <div className="toast" role="status">{notice}</div>}
        </main>
      </div>
      <DetailDialog
        conversation={detailConversation}
        detail={detailUsage}
        loading={detailLoading}
        error={detailError}
        onClose={closeConversationDetail}
      />
    </div>
  );
}
