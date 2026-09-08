import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { colorForIndex, effortName, modelEffortLabel, modelName } from "./labels.mjs";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const RANGE_DAYS = { today: 1, "7d": 7, "30d": 30 };
const ALL_RANGE = "all";
const ROLLOUT_INDEX_VERSION = 2;
const PLAN_STATUS = new Map([
  ["completed", "completed"],
  ["complete", "completed"],
  ["done", "completed"],
  ["in_progress", "in_progress"],
  ["inProgress", "in_progress"],
  ["in-progress", "in_progress"],
  ["pending", "pending"],
]);
const COMPLETION_EVENT_TYPES = new Set([
  "task_complete",
  "task_completed",
  "turn_complete",
  "turn_completed",
  "turn_finished",
]);
const TASK_START_EVENT_TYPES = new Set(["task_started"]);

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Return the short project label that can be safely shown in the dashboard.
 * The full cwd is deliberately never returned to the UI.
 */
export function projectLabelFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "未识别项目";
  const normalized = cwd.trim().replace(/[\\/]+$/, "");
  const label = path.basename(normalized);
  return label || "未识别项目";
}

function normalizedPlan(argumentsValue) {
  let value = argumentsValue;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.plan) || !value.plan.length) return null;
  const steps = value.plan.map((step) => {
    if (!step || typeof step !== "object" || typeof step.step !== "string" || !step.step.trim()) return null;
    const status = PLAN_STATUS.get(step.status);
    return status ? status : null;
  });
  if (steps.some((step) => !step)) return null;
  const completedSteps = steps.filter((status) => status === "completed").length;
  const totalSteps = steps.length;
  return {
    kind: "steps",
    completedSteps,
    totalSteps,
    label: `${completedSteps}/${totalSteps} 步`,
  };
}

/**
 * Parse the arguments of an update_plan function call. This intentionally
 * accepts only a complete, valid plan so malformed calls cannot produce a
 * misleading percentage or partial progress.
 */
export function parseUpdatePlanCall(payload) {
  if (!payload || payload.name !== "update_plan") return null;
  if (payload.type === "function_call") return normalizedPlan(payload.arguments);
  if (payload.type === "custom_tool_call") return normalizedPlan(payload.input ?? payload.arguments);
  return null;
}

function updatedAtLabel(timestampMs, range, now) {
  if (!Number.isFinite(timestampMs)) return "—";
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "—";
  if (range === "today" || localDayKey(date) === localDayKey(now)) return clockLabel(timestampMs);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function verifiedTaskProgress({ progress, turnTimestamps, planTimestampMs }) {
  const latestTurn = Math.max(...turnTimestamps, 0);
  const latestPlan = Number.isFinite(planTimestampMs) ? planTimestampMs : 0;
  if (progress?.kind !== "steps" || latestPlan < latestTurn) return { kind: "none" };
  return progress;
}

function taskStatus({ progress, completionTimestamps, turnTimestamps, planTimestampMs, range = "today" }) {
  const latestCompletion = Math.max(...completionTimestamps, 0);
  const latestTurn = Math.max(...turnTimestamps, 0);
  const latestPlan = Number.isFinite(planTimestampMs) ? planTimestampMs : 0;
  const currentProgress = verifiedTaskProgress({ progress, turnTimestamps, planTimestampMs });
  if (latestCompletion > 0 && latestCompletion >= Math.max(latestTurn, latestPlan)) {
    return { kind: "completed", label: "本轮完成" };
  }
  if (currentProgress.kind === "steps" && currentProgress.completedSteps < currentProgress.totalSteps) {
    return { kind: "steps", label: currentProgress.label };
  }
  if (range === ALL_RANGE) return { kind: "history", label: "历史记录" };
  return { kind: "active", label: range === "today" ? "今日活跃" : "活跃" };
}

function threadIdFromPath(filePath) {
  const matches = path.basename(filePath).match(UUID_PATTERN);
  return matches?.[0] ?? null;
}

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function rangeBounds(range, now = new Date()) {
  if (range === ALL_RANGE) {
    return { startMs: Number.NEGATIVE_INFINITY, endMs: now.getTime(), days: null };
  }
  const days = RANGE_DAYS[range] ?? RANGE_DAYS.today;
  const start = startOfLocalDay(now);
  start.setDate(start.getDate() - (days - 1));
  return { startMs: start.getTime(), endMs: now.getTime(), days };
}

function deltaUsage(current, previous) {
  const reset = !previous || number(current.total_tokens) < number(previous.total_tokens);
  const delta = (key) => {
    const currentValue = number(current[key]);
    if (reset) return currentValue;
    return Math.max(0, currentValue - number(previous[key]));
  };
  return {
    cacheTokensKnown: [current, ...(reset ? [] : [previous])].every((value) =>
      [value.input_tokens, value.cached_input_tokens].every((token) => typeof token === "number" && Number.isFinite(token) && token >= 0)),
    inputTokens: delta("input_tokens"),
    cachedInputTokens: delta("cached_input_tokens"),
    outputTokens: delta("output_tokens"),
    reasoningTokens: delta("reasoning_output_tokens"),
    totalTokens: delta("total_tokens"),
  };
}

function sessionSource(meta) {
  const source = meta?.source;
  const spawn = source?.subagent?.thread_spawn;
  return {
    isSubagent: Boolean(spawn),
    parentThreadId: spawn?.parent_thread_id ?? null,
    agentNickname: spawn?.agent_nickname ?? null,
    agentRole: spawn?.agent_role ?? null,
    isGuardian: source?.subagent?.other === "guardian" || meta?.thread_source === "guardian_review",
  };
}

export async function parseRolloutFile(filePath) {
  let threadId = threadIdFromPath(filePath);
  if (!threadId) return null;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let currentModel = "unknown";
  let currentEffort = "unknown";
  let previousTotal = null;
  let meta = null;
  let source = sessionSource(null);
  let sessionStartMs = null;
  const usageEvents = [];
  const toolEvents = [];
  const turnEvents = [];
  const taskStartEvents = [];
  const completionEvents = [];
  let latestPlanCall = null;
  let lastTimestampMs = null;

  for await (const line of lines) {
    const event = safeJson(line);
    if (!event) continue;
    const timestampMs = Date.parse(event.timestamp);
    if (Number.isFinite(timestampMs)) lastTimestampMs = timestampMs;

    if (event.type === "session_meta") {
      threadId = event.payload?.id ?? event.payload?.session_id ?? threadId;
      meta = event.payload;
      source = sessionSource(meta);
      sessionStartMs = timestampMs;
      continue;
    }

    if (event.type === "turn_context") {
      currentModel = event.payload?.model ?? currentModel;
      currentEffort = event.payload?.effort
        ?? event.payload?.collaboration_mode?.settings?.reasoning_effort
        ?? currentEffort;
      if (Number.isFinite(timestampMs)) turnEvents.push(timestampMs);
      continue;
    }

    if (event.type === "response_item") {
      const itemType = event.payload?.type;
      if ((itemType === "function_call" || itemType === "custom_tool_call") && Number.isFinite(timestampMs)) {
        toolEvents.push(timestampMs);
      }
      if ((itemType === "function_call" || itemType === "custom_tool_call") && event.payload?.name === "update_plan") {
        // Keep the latest call, including an invalid one. Falling back to an
        // older plan after a malformed latest call would make the UI stale.
        latestPlanCall = {
          timestampMs,
          progress: parseUpdatePlanCall(event.payload),
        };
      }
      continue;
    }

    if (event.type === "event_msg") {
      if (TASK_START_EVENT_TYPES.has(event.payload?.type) && Number.isFinite(timestampMs)) {
        taskStartEvents.push(timestampMs);
      }
      if (COMPLETION_EVENT_TYPES.has(event.payload?.type) && Number.isFinite(timestampMs)) {
        completionEvents.push(timestampMs);
      }
    }

    if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;
    const total = event.payload?.info?.total_token_usage;
    if (!total || !Number.isFinite(timestampMs)) continue;
    if (source.isSubagent && sessionStartMs && timestampMs <= sessionStartMs + 5_000) continue;

    const usage = deltaUsage(total, previousTotal);
    previousTotal = total;
    if (usage.totalTokens <= 0) continue;
    usageEvents.push({
      timestampMs,
      model: currentModel,
      effort: currentEffort,
      ...usage,
    });
  }

  return {
    threadId,
    filePath,
    meta,
    source,
    sessionStartMs,
    lastTimestampMs,
    usageEvents,
    toolEvents,
    turnEvents,
    taskStartEvents,
    completionEvents,
    plan: latestPlanCall?.progress ?? null,
    planTimestampMs: latestPlanCall?.timestampMs ?? null,
  };
}

async function walk(dir) {
  const output = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(entryPath));
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) output.push(entryPath);
  }
  return output;
}

async function recentRollouts(codexHome, startMs) {
  const files = [
    ...await walk(path.join(codexHome, "sessions")),
    ...await walk(path.join(codexHome, "archived_sessions")),
  ];
  const floor = startMs - 48 * 60 * 60 * 1_000;
  const recent = [];
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      if (info.mtimeMs >= floor) recent.push(filePath);
    } catch {
      // A session may move to the archive while scanning; skip that path and continue.
    }
  }
  return recent;
}

async function loadTitleIndex(codexHome) {
  const titles = new Map();
  try {
    const content = await readFile(path.join(codexHome, "session_index.jsonl"), "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const row = safeJson(line);
      const id = row?.id ?? row?.thread_id;
      const title = row?.thread_name ?? row?.title;
      if (id && typeof title === "string" && title.trim()) titles.set(id, title.trim());
    }
  } catch {
    // Titles are optional; safe fallback labels are used below.
  }
  return titles;
}

async function parseWithLimit(files, limit = 12) {
  const output = [];
  for (let index = 0; index < files.length; index += limit) {
    const batch = files.slice(index, index + limit);
    output.push(...await Promise.all(batch.map((filePath) => parseRolloutFile(filePath))));
  }
  return output.filter(Boolean);
}

function bucketIndex(timestampMs, range, bounds) {
  const date = new Date(timestampMs);
  if (range === "today") return date.getHours();
  const dayStart = startOfLocalDay(date).getTime();
  return Math.floor((dayStart - bounds.startMs) / 86_400_000);
}

function bucketLabel(index, range, bounds) {
  if (range === "today") {
    return {
      x: index,
      label: `${String(index).padStart(2, "0")}:00`,
    };
  }
  const date = new Date(bounds.startMs + index * 86_400_000);
  return {
    x: `${date.getMonth() + 1}/${date.getDate()}`,
    label: `${date.getMonth() + 1}月${date.getDate()}日`,
  };
}

function emptyBreakdown() {
  return {
    cacheTokensKnown: true,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addBreakdown(target, usage) {
  target.cacheTokensKnown = target.cacheTokensKnown !== false && usage.cacheTokensKnown === true;
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
}

function modelBreakdownEntries(modelTotals) {
  return [...modelTotals.entries()].map(([id, breakdown]) => ({
    id,
    breakdown: { ...breakdown },
  }));
}

function modelUsageEntries(modelTotals, totalTokens) {
  return [...modelTotals.entries()]
    .sort((first, second) => second[1].totalTokens - first[1].totalTokens || first[0].localeCompare(second[0]))
    .map(([id, breakdown]) => {
      const [model = "unknown", effort = "unknown"] = id.split("|", 2);
      return {
        id,
        label: modelEffortLabel(model, effort),
        tokens: breakdown.totalTokens,
        share: totalTokens ? (breakdown.totalTokens / totalTokens) * 100 : 0,
        breakdown: { ...breakdown },
      };
    });
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, month] = String(key).split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return String(key);
  return `${year}年${month}月`;
}

function monthKeysBetween(startDay, endDay) {
  const [startYear, startMonth, startDate] = String(startDay).split("-").map(Number);
  const start = Number.isInteger(startYear) && Number.isInteger(startMonth) && Number.isInteger(startDate)
    ? new Date(startYear, startMonth - 1, startDate)
    : new Date(Number.NaN);
  const end = new Date(endDay);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  const output = [];
  while (cursor <= last) {
    output.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return output;
}

function latestTimestamp(timestamps) {
  const values = timestamps.filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

/**
 * Convert one parsed rollout into a privacy-safe aggregate. This is the only
 * payload persisted in SQLite for the cumulative index: prompts, responses,
 * raw event objects and full cwd values are intentionally discarded.
 */
function aggregateRolloutForIndex(session) {
  const days = new Map();
  let firstTimestampMs = Number.POSITIVE_INFINITY;
  let lastUsageTimestampMs = 0;

  for (const event of session.usageEvents) {
    const date = new Date(event.timestampMs);
    if (Number.isNaN(date.getTime())) continue;
    const day = localDayKey(date);
    if (!days.has(day)) days.set(day, { breakdown: emptyBreakdown(), modelTotals: new Map() });
    const aggregate = days.get(day);
    addBreakdown(aggregate.breakdown, event);
    const modelId = `${event.model}|${event.effort}`;
    if (!aggregate.modelTotals.has(modelId)) aggregate.modelTotals.set(modelId, emptyBreakdown());
    addBreakdown(aggregate.modelTotals.get(modelId), event);
    firstTimestampMs = Math.min(firstTimestampMs, event.timestampMs);
    lastUsageTimestampMs = Math.max(lastUsageTimestampMs, event.timestampMs);
  }

  const activityTimestamps = [
    ...session.usageEvents.map((event) => event.timestampMs),
    ...session.toolEvents,
    ...session.turnEvents,
    ...session.taskStartEvents,
    ...session.completionEvents,
  ];
  if (Number.isFinite(session.lastTimestampMs)) activityTimestamps.push(session.lastTimestampMs);

  return {
    version: ROLLOUT_INDEX_VERSION,
    threadId: session.threadId,
    source: {
      isSubagent: Boolean(session.source?.isSubagent),
      parentThreadId: session.source?.parentThreadId ?? null,
      agentNickname: session.source?.agentNickname ?? null,
      agentRole: session.source?.agentRole ?? null,
      isGuardian: Boolean(session.source?.isGuardian),
    },
    projectLabel: projectLabelFromCwd(session.meta?.cwd),
    sessionStartMs: Number.isFinite(session.sessionStartMs) ? session.sessionStartMs : null,
    firstTimestampMs: Number.isFinite(firstTimestampMs) ? firstTimestampMs : null,
    lastUsageTimestampMs: lastUsageTimestampMs || null,
    lastTimestampMs: Number.isFinite(session.lastTimestampMs) ? session.lastTimestampMs : null,
    activeDurationMs: activeDurationMs(activityTimestamps),
    toolCalls: session.toolEvents.length,
    turns: session.turnEvents.length + session.taskStartEvents.length,
    latestTurnTimestampMs: latestTimestamp([...session.turnEvents, ...session.taskStartEvents]),
    latestCompletionTimestampMs: latestTimestamp(session.completionEvents),
    plan: session.plan,
    planTimestampMs: Number.isFinite(session.planTimestampMs) ? session.planTimestampMs : null,
    days: Object.fromEntries([...days.entries()].map(([day, aggregate]) => [day, {
      breakdown: aggregate.breakdown,
      modelTotals: modelBreakdownEntries(aggregate.modelTotals),
    }])),
  };
}

function parseRolloutIndexPayload(value) {
  if (!value || typeof value !== "object" || value.version !== ROLLOUT_INDEX_VERSION) return null;
  if (typeof value.threadId !== "string" || !value.threadId) return null;
  if (!value.source || typeof value.source !== "object") return null;
  if (!value.days || typeof value.days !== "object" || Array.isArray(value.days)) return null;
  for (const [day, aggregate] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    if (!aggregate || typeof aggregate !== "object" || !aggregate.breakdown || !Array.isArray(aggregate.modelTotals)) return null;
    if (aggregate.modelTotals.some((item) => !item || typeof item.id !== "string" || !item.breakdown)) return null;
  }
  return value;
}

async function statRolloutFiles(files) {
  const output = [];
  for (const filePath of [...new Set(files)]) {
    try {
      const info = await stat(filePath);
      if (info.isFile()) output.push({ filePath, fileSize: info.size, fileMtimeMs: info.mtimeMs });
    } catch {
      // A session may be moved or deleted while the index is refreshed.
    }
  }
  return output;
}

async function buildRolloutIndex({ codexHome, files, indexStore }) {
  const rolloutFiles = files ?? [
    ...await walk(path.join(codexHome, "sessions")),
    ...await walk(path.join(codexHome, "archived_sessions")),
  ];
  const currentFiles = await statRolloutFiles(rolloutFiles);
  const cachedRows = indexStore?.listRolloutIndex?.() ?? [];
  const cachedByPath = new Map(cachedRows.map((row) => [row.file_path, row]));
  const parsedPayloads = new Map();
  const changedFiles = currentFiles.filter((file) => {
    const cached = cachedByPath.get(file.filePath);
    return !cached
      || Number(cached.file_size) !== Number(file.fileSize)
      || Number(cached.file_mtime_ms) !== Number(file.fileMtimeMs)
      || !parseRolloutIndexPayload(safeJson(cached.payload_json));
  });
  const changedPaths = new Set(changedFiles.map((file) => file.filePath));

  // Keep parsed rollout objects to one small batch at a time. A first all-time
  // scan can therefore process a large history without retaining raw events
  // for every file in memory.
  for (let index = 0; index < changedFiles.length; index += 3) {
    const batch = changedFiles.slice(index, index + 3);
    const parsedBatch = await Promise.all(batch.map(async (file) => ({
      file,
      parsed: await parseRolloutFile(file.filePath),
    })));
    for (const { file, parsed } of parsedBatch) {
      if (parsed) parsedPayloads.set(file.filePath, aggregateRolloutForIndex(parsed));
    }
  }

  const entries = [];
  const changedEntries = [];
  const failedPaths = [];
  for (const file of currentFiles) {
    const cached = cachedByPath.get(file.filePath);
    const cachedPayload = cached ? parseRolloutIndexPayload(safeJson(cached.payload_json)) : null;
    const payload = parsedPayloads.get(file.filePath) ?? cachedPayload;
    if (!payload) {
      if (changedPaths.has(file.filePath)) failedPaths.push(file.filePath);
      continue;
    }
    const entry = { ...file, payload };
    entries.push(entry);
    if (changedPaths.has(file.filePath)) changedEntries.push(entry);
  }

  indexStore?.saveRolloutIndex?.(
    changedEntries,
    currentFiles.map((file) => file.filePath),
    failedPaths,
  );
  return {
    records: entries.map((entry) => entry.payload),
    scannedFiles: currentFiles.length,
    reparsedFiles: changedFiles.length,
    reusedFiles: Math.max(0, currentFiles.length - changedFiles.length),
    removedFiles: new Set([
      ...cachedRows
        .filter((row) => !currentFiles.some((file) => file.filePath === row.file_path))
        .map((row) => row.file_path),
      ...failedPaths,
    ]).size,
  };
}

function allPeriodStart(records, now) {
  const currentDay = localDayKey(now);
  const timestamps = records
    .map((record) => record.firstTimestampMs)
    .filter((timestampMs) => Number.isFinite(timestampMs) && timestampMs <= now.getTime());
  if (!timestamps.length) return currentDay;
  return localDayKey(new Date(Math.min(...timestamps)));
}

function dailyRecordInRange(record, dayEnd) {
  if (!record?.days || typeof record.days !== "object") return [];
  return Object.entries(record.days)
    .filter(([day]) => day <= dayEnd)
    .sort(([first], [second]) => first.localeCompare(second));
}

function addDailyAggregate(group, aggregate, chartBuckets, month) {
  if (!aggregate || typeof aggregate !== "object") return;
  addBreakdown(group.breakdown, aggregate.breakdown ?? emptyBreakdown());
  for (const modelEntry of aggregate.modelTotals ?? []) {
    if (!modelEntry || typeof modelEntry.id !== "string") continue;
    if (!group.modelTotals.has(modelEntry.id)) group.modelTotals.set(modelEntry.id, emptyBreakdown());
    addBreakdown(group.modelTotals.get(modelEntry.id), modelEntry.breakdown ?? emptyBreakdown());
    const key = `${modelEntry.id}|${month}`;
    chartBuckets.set(key, (chartBuckets.get(key) ?? 0) + number(modelEntry.breakdown?.totalTokens));
  }
}

function allTimestampLabel(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));
}

function buildAllDashboard(records, { codexHome, now, schedulerConfigured, indexStats }) {
  const currentDay = localDayKey(now);
  const periodStart = allPeriodStart(records, now);
  const monthKeys = monthKeysBetween(periodStart, now);
  const bucketCount = monthKeys.length;
  const groups = new Map();
  const modelTotals = new Map();
  const chartBuckets = new Map();
  const seenRecordFingerprints = new Set();

  function ensureGroup(record) {
    const source = record.source ?? {};
    const groupId = source.isGuardian ? "__codex_guardian__" : (source.parentThreadId ?? record.threadId);
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        groupId,
        threadIds: new Set(),
        childIds: new Set(),
        isGuardian: Boolean(source.isGuardian),
        agentNickname: source.agentNickname ?? null,
        agentRole: source.agentRole ?? null,
        breakdown: emptyBreakdown(),
        modelTotals: new Map(),
        activity: Array.from({ length: bucketCount }, () => 0),
        toolCalls: 0,
        turns: 0,
        activeDurationMs: 0,
        turnTimestampMs: 0,
        completionTimestampMs: 0,
        latestPlan: null,
        latestPlanTimestampMs: null,
        projectLabel: "未识别项目",
        firstTimestampMs: Number.POSITIVE_INFINITY,
        lastTimestampMs: 0,
      });
    }
    const group = groups.get(groupId);
    group.threadIds.add(record.threadId);
    if (source.isSubagent) group.childIds.add(record.threadId);
    if (source.agentNickname) group.agentNickname = source.agentNickname;
    if (source.agentRole) group.agentRole = source.agentRole;
    if (record.projectLabel && (!group.projectLabel || !source.isSubagent)) group.projectLabel = record.projectLabel;
    return group;
  }

  for (const record of records) {
    // A rollout can briefly exist in both sessions and archived_sessions while
    // Codex moves it. Exact aggregate duplicates must not inflate cumulative
    // totals; separate records with different aggregate content remain valid
    // continuation activity for the same thread.
    const recordFingerprint = `${record.threadId}|${record.firstTimestampMs}|${record.lastUsageTimestampMs}|${JSON.stringify(record.days)}`;
    if (seenRecordFingerprints.has(recordFingerprint)) continue;
    seenRecordFingerprints.add(recordFingerprint);
    const dayEntries = dailyRecordInRange(record, currentDay);
    if (!dayEntries.length) continue;
    const group = ensureGroup(record);
    for (const [day, aggregate] of dayEntries) {
      const month = day.slice(0, 7);
      const index = monthKeys.indexOf(month);
      if (index < 0) continue;
      addDailyAggregate(group, aggregate, chartBuckets, month);
      group.activity[index] += number(aggregate.breakdown?.totalTokens);
      for (const modelEntry of aggregate.modelTotals ?? []) {
        if (!modelEntry || typeof modelEntry.id !== "string") continue;
        if (!modelTotals.has(modelEntry.id)) modelTotals.set(modelEntry.id, emptyBreakdown());
        addBreakdown(modelTotals.get(modelEntry.id), modelEntry.breakdown ?? emptyBreakdown());
      }
    }
    group.toolCalls += number(record.toolCalls);
    group.turns += number(record.turns);
    group.activeDurationMs += number(record.activeDurationMs);
    if (Number.isFinite(record.firstTimestampMs) && record.firstTimestampMs <= now.getTime()) {
      group.firstTimestampMs = Math.min(group.firstTimestampMs, record.firstTimestampMs);
    }
    const lastUsage = Number.isFinite(record.lastUsageTimestampMs) ? record.lastUsageTimestampMs : record.lastTimestampMs;
    if (Number.isFinite(lastUsage)) group.lastTimestampMs = Math.max(group.lastTimestampMs, Math.min(lastUsage, now.getTime()));
    if (Number.isFinite(record.latestTurnTimestampMs)) {
      group.turnTimestampMs = Math.max(group.turnTimestampMs, Math.min(record.latestTurnTimestampMs, now.getTime()));
    }
    if (Number.isFinite(record.latestCompletionTimestampMs)) {
      group.completionTimestampMs = Math.max(group.completionTimestampMs, Math.min(record.latestCompletionTimestampMs, now.getTime()));
    }
    if (Number.isFinite(record.planTimestampMs) && record.planTimestampMs <= now.getTime()
      && (!group.latestPlanTimestampMs || record.planTimestampMs >= group.latestPlanTimestampMs)) {
      group.latestPlanTimestampMs = record.planTimestampMs;
      group.latestPlan = record.plan;
    }
  }

  const total = emptyBreakdown();
  let totalToolCalls = 0;
  for (const group of groups.values()) {
    addBreakdown(total, group.breakdown);
    totalToolCalls += group.toolCalls;
  }

  const sortedModels = [...modelTotals.entries()]
    .sort((first, second) => second[1].totalTokens - first[1].totalTokens)
    .map(([id, breakdown], index) => {
      const [model, effort] = id.split("|");
      return {
        id,
        model,
        effort,
        label: modelEffortLabel(model, effort),
        color: colorForIndex(index),
        tokens: breakdown.totalTokens,
        share: total.totalTokens ? (breakdown.totalTokens / total.totalTokens) * 100 : 0,
        breakdown,
      };
    });

  const chart = [];
  let peak = null;
  for (const model of sortedModels) {
    for (let index = 0; index < bucketCount; index += 1) {
      const key = `${model.id}|${monthKeys[index]}`;
      const point = {
        x: monthKeys[index],
        label: monthLabel(monthKeys[index]),
        seriesId: model.id,
        tokens: chartBuckets.get(key) ?? 0,
        isPeak: false,
      };
      chart.push(point);
      if (!peak || point.tokens > peak.tokens) peak = point;
    }
  }
  if (peak) peak.isPeak = true;

  const titlesPromise = loadTitleIndex(codexHome);
  // The caller awaits this builder, but retaining a promise here would make
  // title lookup unnecessarily easy to forget. This function is synchronous;
  // titles are attached by collectAllUsage below.
  return { total, totalToolCalls, groups, sortedModels, chart, monthKeys, titlesPromise, periodStart };
}

function finalizeAllDashboard(base, { titles, now, schedulerConfigured, indexStats }) {
  const { total, totalToolCalls, groups, sortedModels, chart, monthKeys, periodStart } = base;
  const conversationGroups = [...groups.values()].filter((group) => group.breakdown.totalTokens > 0);
  const conversations = conversationGroups
    .sort((first, second) => second.breakdown.totalTokens - first.breakdown.totalTokens)
    .map((group, index) => {
      const primary = [...group.modelTotals.entries()].sort((first, second) => second[1].totalTokens - first[1].totalTokens)[0];
      const [primaryId = "unknown|unknown"] = primary ?? [];
      const [model, effort] = primaryId.split("|");
      const modelMeta = sortedModels.find((item) => item.id === primaryId);
      const turnTimestamps = group.turnTimestampMs ? [group.turnTimestampMs] : [];
      const completionTimestamps = group.completionTimestampMs ? [group.completionTimestampMs] : [];
      const progress = verifiedTaskProgress({
        progress: group.latestPlan,
        turnTimestamps,
        planTimestampMs: group.latestPlanTimestampMs,
      });
      const status = taskStatus({
        progress,
        completionTimestamps,
        turnTimestamps,
        planTimestampMs: group.latestPlanTimestampMs,
        range: ALL_RANGE,
      });
      const updatedMs = group.lastTimestampMs > 0 ? group.lastTimestampMs : null;
      return {
        id: group.groupId,
        rank: index + 1,
        title: safeTitle(group, titles),
        modelLabel: modelName(model),
        effortLabel: effortName(effort),
        color: modelMeta?.color ?? colorForIndex(index),
        tokens: group.breakdown.totalTokens,
        share: total.totalTokens ? (group.breakdown.totalTokens / total.totalTokens) * 100 : 0,
        toolCalls: group.toolCalls,
        turns: group.turns,
        childCount: group.childIds.size,
        startedAtLabel: Number.isFinite(group.firstTimestampMs) ? allTimestampLabel(group.firstTimestampMs) : "—",
        durationLabel: durationLabel(group.activeDurationMs),
        activity: group.activity,
        breakdown: group.breakdown,
        modelUsage: modelUsageEntries(group.modelTotals, group.breakdown.totalTokens),
        isSystem: group.isGuardian,
        projectLabel: group.projectLabel,
        updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
        updatedAtLabel: updatedMs ? allTimestampLabel(updatedMs) : "—",
        progress,
        status: status.label,
        statusKind: status.kind,
      };
    });

  const cacheShare = total.inputTokens ? (total.cachedInputTokens / total.inputTokens) * 100 : 0;
  const humanConversationCount = conversationGroups.filter((group) => !group.isGuardian).length;
  return {
    version: 2,
    range: ALL_RANGE,
    periodLabel: "累计",
    periodStart,
    periodEnd: localDayKey(now),
    generatedAt: now.toISOString(),
    dataSource: "local",
    totals: {
      tokens: total.totalTokens,
      conversations: humanConversationCount,
      tasks: humanConversationCount,
      toolCalls: totalToolCalls,
      cacheShare,
      inputTokens: total.inputTokens,
      cachedInputTokens: total.cachedInputTokens,
      outputTokens: total.outputTokens,
      reasoningTokens: total.reasoningTokens,
    },
    models: sortedModels,
    chart,
    conversations,
    tasks: conversations,
    quality: {
      usage: "token_count cumulative delta",
      attribution: "nearest preceding turn_context",
      duration: "indexed event gaps capped at 15 minutes",
      taskProgress: "update_plan steps only; no inferred percentage",
      taskStatus: "task/turn completion events only; otherwise active with updated time",
      scannedFiles: indexStats?.scannedFiles ?? 0,
      indexedFiles: indexStats?.scannedFiles ?? 0,
      reparsedFiles: indexStats?.reparsedFiles ?? 0,
      reusedFiles: indexStats?.reusedFiles ?? 0,
      removedFiles: indexStats?.removedFiles ?? 0,
      localTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedulerConfigured,
      officialDailyTotal: null,
      cumulativeScope: "currently retained local Codex session logs",
      trendBucket: "local month",
      periodMonths: monthKeys,
    },
  };
}

async function collectAllUsage({ now, codexHome, files, indexStore }) {
  const schedulerPath = path.join(homedir(), "Library", "LaunchAgents", "com.codex.token-usage-insights.plist");
  const schedulerConfigured = await stat(schedulerPath).then(() => true).catch(() => false);
  const indexResult = await buildRolloutIndex({ codexHome, files, indexStore });
  const base = buildAllDashboard(indexResult.records, { codexHome, now, schedulerConfigured, indexStats: indexResult });
  const titles = await base.titlesPromise;
  return finalizeAllDashboard(base, { titles, now, schedulerConfigured, indexStats: indexResult });
}

function durationLabel(durationMs) {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function activeDurationMs(timestamps) {
  const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  if (sorted.length === 1) return 60_000;
  const maximumGap = 15 * 60 * 1_000;
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += Math.min(maximumGap, Math.max(0, sorted[index] - sorted[index - 1]));
  }
  return Math.max(60_000, total);
}

function clockLabel(timestampMs) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));
}

function safeTitle(group, titles) {
  if (group.isGuardian) return "自动审查（系统汇总）";
  const indexed = titles.get(group.groupId);
  if (indexed) return indexed;
  if (group.agentNickname) return `${group.agentNickname} · ${group.agentRole ?? "子任务"}`;
  return `Codex 对话 · ${group.groupId.slice(0, 8)}`;
}

export async function collectUsage({
  range = "today",
  now = new Date(),
  codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  files = null,
  indexStore = null,
} = {}) {
  if (range === ALL_RANGE) {
    return collectAllUsage({ range, now, codexHome, files, indexStore });
  }
  const bounds = rangeBounds(range, now);
  const schedulerPath = path.join(homedir(), "Library", "LaunchAgents", "com.codex.token-usage-insights.plist");
  const schedulerConfigured = await stat(schedulerPath).then(() => true).catch(() => false);
  const rolloutFiles = files ?? await recentRollouts(codexHome, bounds.startMs);
  const titles = await loadTitleIndex(codexHome);
  const parsed = await parseWithLimit(rolloutFiles);
  const groups = new Map();
  const modelTotals = new Map();
  const chartBuckets = new Map();
  const seenUsage = new Set();
  const bucketCount = range === "today" ? 24 : bounds.days;

  function ensureGroup(session) {
    const groupId = session.source.isGuardian
      ? "__codex_guardian__"
      : (session.source.parentThreadId ?? session.threadId);
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        groupId,
        threadIds: new Set(),
        childIds: new Set(),
        isGuardian: session.source.isGuardian,
        agentNickname: session.source.agentNickname,
        agentRole: session.source.agentRole,
        breakdown: emptyBreakdown(),
        modelTotals: new Map(),
        activity: Array.from({ length: bucketCount }, () => 0),
        toolCalls: 0,
        turns: 0,
        activeTimestamps: [],
        turnTimestamps: new Set(),
        completionTimestamps: [],
        latestPlan: null,
        latestPlanTimestampMs: null,
        projectCwd: null,
        firstTimestampMs: Number.POSITIVE_INFINITY,
        lastTimestampMs: 0,
      });
    }
    const group = groups.get(groupId);
    group.threadIds.add(session.threadId);
    if (session.source.isSubagent) group.childIds.add(session.threadId);
    if (session.source.agentNickname) group.agentNickname = session.source.agentNickname;
    if (session.source.agentRole) group.agentRole = session.source.agentRole;
    const cwd = session.meta?.cwd;
    // Prefer the root conversation's cwd when a group contains subagents.
    if (typeof cwd === "string" && cwd.trim() && (!group.projectCwd || !session.source.isSubagent)) {
      group.projectCwd = cwd;
    }
    return group;
  }

  for (const session of parsed) {
    const group = ensureGroup(session);
    for (const event of session.usageEvents) {
      if (event.timestampMs < bounds.startMs || event.timestampMs > bounds.endMs) continue;
      const fingerprint = `${session.threadId}|${event.timestampMs}|${event.totalTokens}|${event.model}|${event.effort}`;
      if (seenUsage.has(fingerprint)) continue;
      seenUsage.add(fingerprint);
      addBreakdown(group.breakdown, event);
      group.activeTimestamps.push(event.timestampMs);
      const modelId = `${event.model}|${event.effort}`;
      if (!group.modelTotals.has(modelId)) group.modelTotals.set(modelId, emptyBreakdown());
      addBreakdown(group.modelTotals.get(modelId), event);
      if (!modelTotals.has(modelId)) modelTotals.set(modelId, emptyBreakdown());
      addBreakdown(modelTotals.get(modelId), event);

      const index = bucketIndex(event.timestampMs, range, bounds);
      if (index >= 0 && index < bucketCount) {
        group.activity[index] += event.totalTokens;
        const key = `${modelId}|${index}`;
        chartBuckets.set(key, (chartBuckets.get(key) ?? 0) + event.totalTokens);
      }
      group.firstTimestampMs = Math.min(group.firstTimestampMs, event.timestampMs);
      group.lastTimestampMs = Math.max(group.lastTimestampMs, event.timestampMs);
    }

    const inRange = (timestampMs) => timestampMs >= bounds.startMs && timestampMs <= bounds.endMs;
    const toolEvents = session.toolEvents.filter(inRange);
    const turnEvents = session.turnEvents.filter(inRange);
    const taskStartEvents = session.taskStartEvents.filter(inRange);
    group.toolCalls += toolEvents.length;
    group.turns += turnEvents.length;
    group.activeTimestamps.push(...toolEvents, ...turnEvents, ...taskStartEvents);
    for (const timestampMs of [...turnEvents, ...taskStartEvents]) group.turnTimestamps.add(timestampMs);
    group.completionTimestamps.push(...session.completionEvents.filter(inRange));
    const eventTimestamps = [
      ...toolEvents,
      ...turnEvents,
      ...taskStartEvents,
      ...session.completionEvents.filter(inRange),
    ];
    if (Number.isFinite(session.lastTimestampMs) && inRange(session.lastTimestampMs)) {
      eventTimestamps.push(session.lastTimestampMs);
    }
    if (Number.isFinite(session.planTimestampMs) && inRange(session.planTimestampMs)) {
      eventTimestamps.push(session.planTimestampMs);
      if (!group.latestPlanTimestampMs || session.planTimestampMs >= group.latestPlanTimestampMs) {
        group.latestPlanTimestampMs = session.planTimestampMs;
        group.latestPlan = session.plan;
      }
    }
    if (eventTimestamps.length) group.lastTimestampMs = Math.max(group.lastTimestampMs, ...eventTimestamps);
  }

  const total = emptyBreakdown();
  let totalToolCalls = 0;
  for (const group of groups.values()) {
    addBreakdown(total, group.breakdown);
    totalToolCalls += group.toolCalls;
  }

  const sortedModels = [...modelTotals.entries()]
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .map(([id, breakdown], index) => {
      const [model, effort] = id.split("|");
      return {
        id,
        model,
        effort,
        label: modelEffortLabel(model, effort),
        color: colorForIndex(index),
        tokens: breakdown.totalTokens,
        share: total.totalTokens ? (breakdown.totalTokens / total.totalTokens) * 100 : 0,
        breakdown,
      };
    });

  let peak = null;
  const chart = [];
  for (const model of sortedModels) {
    for (let index = 0; index < bucketCount; index += 1) {
      const tokens = chartBuckets.get(`${model.id}|${index}`) ?? 0;
      const label = bucketLabel(index, range, bounds);
      const point = { ...label, seriesId: model.id, tokens, isPeak: false };
      chart.push(point);
      if (!peak || point.tokens > peak.tokens) peak = point;
    }
  }
  if (peak) peak.isPeak = true;

  const conversationGroups = [...groups.values()].filter((group) => group.breakdown.totalTokens > 0);
  const conversations = conversationGroups
    .sort((a, b) => b.breakdown.totalTokens - a.breakdown.totalTokens)
    .map((group, index) => {
      const primary = [...group.modelTotals.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens)[0];
      const [primaryId = "unknown|unknown"] = primary ?? [];
      const [model, effort] = primaryId.split("|");
      const modelMeta = sortedModels.find((item) => item.id === primaryId);
      const durationMs = activeDurationMs(group.activeTimestamps);
      const turnTimestamps = [...group.turnTimestamps];
      const progress = verifiedTaskProgress({
        progress: group.latestPlan,
        turnTimestamps,
        planTimestampMs: group.latestPlanTimestampMs,
      });
      const status = taskStatus({
        progress,
        completionTimestamps: group.completionTimestamps,
        turnTimestamps,
        planTimestampMs: group.latestPlanTimestampMs,
        range,
      });
      const updatedMs = Number.isFinite(group.lastTimestampMs) && group.lastTimestampMs > 0
        ? group.lastTimestampMs
        : null;
      return {
        id: group.groupId,
        rank: index + 1,
        title: safeTitle(group, titles),
        modelLabel: modelName(model),
        effortLabel: effortName(effort),
        color: modelMeta?.color ?? colorForIndex(index),
        tokens: group.breakdown.totalTokens,
        share: total.totalTokens ? (group.breakdown.totalTokens / total.totalTokens) * 100 : 0,
        toolCalls: group.toolCalls,
        turns: group.turns,
        childCount: group.childIds.size,
        startedAtLabel: Number.isFinite(group.firstTimestampMs) ? clockLabel(group.firstTimestampMs) : "—",
        durationLabel: durationLabel(durationMs),
        activity: group.activity,
        breakdown: group.breakdown,
        modelUsage: modelUsageEntries(group.modelTotals, group.breakdown.totalTokens),
        isSystem: group.isGuardian,
        projectLabel: projectLabelFromCwd(group.projectCwd),
        updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
        updatedAtLabel: updatedAtLabel(updatedMs, range, now),
        progress,
        status: status.label,
        statusKind: status.kind,
      };
    });

  const cacheShare = total.inputTokens ? (total.cachedInputTokens / total.inputTokens) * 100 : 0;
  const humanConversationCount = conversationGroups.filter((group) => !group.isGuardian).length;
  return {
    version: 2,
    range,
    periodLabel: range === "today" ? "今天" : range === "7d" ? "最近 7 天" : "最近 30 天",
    periodStart: localDayKey(new Date(bounds.startMs)),
    periodEnd: localDayKey(new Date(bounds.endMs)),
    generatedAt: now.toISOString(),
    dataSource: "local",
      totals: {
        tokens: total.totalTokens,
        conversations: humanConversationCount,
        tasks: humanConversationCount,
        toolCalls: totalToolCalls,
      cacheShare,
      inputTokens: total.inputTokens,
      cachedInputTokens: total.cachedInputTokens,
      outputTokens: total.outputTokens,
      reasoningTokens: total.reasoningTokens,
    },
    models: sortedModels,
    chart,
    conversations,
    tasks: conversations,
    quality: {
      usage: "token_count cumulative delta",
      attribution: "nearest preceding turn_context",
      duration: "event gaps capped at 15 minutes",
      taskProgress: "update_plan steps only; no inferred percentage",
      taskStatus: "task/turn completion events only; otherwise active with updated time",
      scannedFiles: parsed.length,
      localTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedulerConfigured,
      officialDailyTotal: null,
    },
  };
}
