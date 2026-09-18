import { homedir } from "node:os";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
// Rollout files are not a heartbeat stream: a live reasoning/tool phase can
// legitimately be silent for minutes. Keep ambiguous tail activity bounded,
// while an explicit task_started without a matching completion gets a longer
// lifecycle window.
const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_EXPLICIT_ACTIVE_WINDOW_MS = 30 * 60 * 1_000;
const DEFAULT_COMPLETED_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_TAIL_BYTES = 256 * 1_024;

const TASK_START_TYPES = new Set(["task_started"]);
const USER_MESSAGE_TYPES = new Set(["user_message"]);
const COMPLETION_TYPES = new Set([
  "task_complete",
  "task_completed",
  "turn_complete",
  "turn_completed",
  "turn_finished",
]);
const WAITING_TYPES = new Set([
  "approval_requested",
  "approval_request",
  "recommended_pending_user_approval",
  "confirmation_requested",
  "confirmation_required",
  "waiting_user_confirmation",
  "waiting_user",
  "request_user_input",
  "user_input_requested",
  "awaiting_confirmation",
  "awaiting_user_input",
  "waiting_for_user",
  "task_paused",
  "turn_paused",
]);

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function eventSignals(event) {
  if (!event || typeof event !== "object") return [];
  const payload = event.payload && typeof event.payload === "object" ? event.payload : null;
  const signals = [
    normalizedType(event.type),
    normalizedType(payload?.type),
    normalizedType(payload?.status),
    normalizedType(payload?.state),
    normalizedType(payload?.reason),
  ];
  // Some Codex adapters put the approval state on the emitted item rather
  // than on the event payload itself. Keep this deliberately shallow so
  // arbitrary tool output or conversation text cannot turn the badge yellow.
  for (const item of [payload?.item, payload?.request, payload?.result]) {
    if (!item || typeof item !== "object") continue;
    signals.push(
      normalizedType(item.type),
      normalizedType(item.status),
      normalizedType(item.state),
      normalizedType(item.reason),
    );
  }
  return signals.filter(Boolean);
}

function hasWaitingSignal(event) {
  const signals = eventSignals(event);
  return signals.some((signal) => WAITING_TYPES.has(signal)
    || signal.includes("approval_requested")
    || signal.includes("confirmation_required")
    || signal.includes("user_input_requested")
    || signal.includes("waiting_for_user"));
}

function hasType(event, types) {
  return eventSignals(event).some((signal) => types.has(signal));
}

async function readTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const info = await handle.stat();
    const length = Math.min(Number(info.size) || 0, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, Number(info.size) - length));
    const text = buffer.toString("utf8");
    return Number(info.size) > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function recentFiles(codexHome, now, lookbackMs) {
  const roots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ];
  const cutoffMs = now.getTime() - lookbackMs;

  async function scan(directory, depth = 0) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) {
        files.push(...await scan(entryPath, depth + 1));
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(entryPath);
        if (info.mtimeMs >= cutoffMs) files.push(entryPath);
      } catch {
        // A rollout can rotate while the directory is being scanned.
      }
    }
    return files;
  }

  return [...new Set((await Promise.all(roots.map((root) => scan(root)))).flat())];
}

function textFromContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).join(" ");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.output_text, value.input_text, value.message, value.content]
    .map(textFromContent)
    .filter(Boolean)
    .join(" ");
}

function assistantMessageText(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : null;
  if (!payload) return "";
  const type = normalizedType(payload.type);
  if (type === "agent_message") return textFromContent(payload.message);
  if (type !== "message" || (payload.role && payload.role !== "assistant")) return "";
  return textFromContent(payload.content ?? payload.message);
}

function hasWaitingMessage(event) {
  const text = assistantMessageText(event)
    // Do not treat a message that merely mentions an event/status identifier
    // (for example `waiting_user_confirmation`) as a real user-facing wait.
    .replace(/`[^`]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return [
    /(?:^|[。！？!?，、；：:\s])请(?:直接)?(?:回复|确认|授权).{0,48}(?:继续|确认|授权)/i,
    /(?:等待(?:你|用户|你的|您的)|等你|等用户|需要你|需要你的|需要您的).{0,32}(?:确认|授权|回复|指令)/i,
    /(?:^|[。！？!?，、；：:\s])(?:请|回复|确认|点击|选择|输入).{0,24}(?:继续授权|确认授权|授权后继续)/i,
    /\b(?:waiting|awaiting)\s+(?:for\s+)?(?:your|the\s+user(?:'s)?|user)?\s*(?:approval|confirmation|authorization|input)\b/i,
    /\bplease\s+(?:confirm|approve|authorize|reply)\b(?:.{0,32}\b(?:continue|proceed)\b)?/i,
  ].some((pattern) => pattern.test(text));
}

async function summarizeFile(filePath, nowMs, {
  lookbackMs,
  activeWindowMs,
  explicitActiveWindowMs,
  completedWindowMs,
  tailBytes,
}) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.mtimeMs < nowMs - lookbackMs) return null;

  let text;
  try {
    text = await readTail(filePath, tailBytes);
  } catch {
    return null;
  }

  let latestStartMs = 0;
  let latestCompletionMs = 0;
  let latestWaitingMs = 0;
  let latestEventMs = 0;
  let latestUserMessageMs = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const eventMs = timestampMs(event?.timestamp);
    if (!Number.isFinite(eventMs)) continue;
    latestEventMs = Math.max(latestEventMs, eventMs);
    if (hasType(event, TASK_START_TYPES)) latestStartMs = Math.max(latestStartMs, eventMs);
    if (hasType(event, COMPLETION_TYPES)) latestCompletionMs = Math.max(latestCompletionMs, eventMs);
    if (hasType(event, USER_MESSAGE_TYPES)) latestUserMessageMs = Math.max(latestUserMessageMs, eventMs);
    if (hasWaitingSignal(event) || hasWaitingMessage(event)) latestWaitingMs = Math.max(latestWaitingMs, eventMs);
  }

  const activityMs = Math.max(latestEventMs, info.mtimeMs);
  if (latestWaitingMs > Math.max(latestStartMs, latestCompletionMs, latestUserMessageMs)
    && nowMs - latestWaitingMs <= lookbackMs) {
    return { kind: "waiting", timestampMs: latestWaitingMs };
  }
  if (latestStartMs > latestCompletionMs && nowMs - activityMs <= explicitActiveWindowMs) {
    return { kind: "running", timestampMs: activityMs };
  }
  // A very large rollout may push task_started outside the tail window. A
  // recently modified file with no terminal event is still an active signal.
  if (!latestStartMs && !latestCompletionMs && latestEventMs && nowMs - activityMs <= activeWindowMs) {
    return { kind: "running", timestampMs: activityMs };
  }
  if (latestCompletionMs > latestStartMs && nowMs - latestCompletionMs <= completedWindowMs) {
    return { kind: "completed", timestampMs: latestCompletionMs };
  }
  return null;
}

/**
 * Read only the tail of recent rollout files and expose a privacy-safe
 * activity signal for the native menu-bar icon. Prompts, titles and paths are
 * deliberately excluded; the dashboard data itself is not refreshed here.
 */
export async function readActivityStatus({
  codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  now = new Date(),
  files = null,
  lookbackMs = DEFAULT_LOOKBACK_MS,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS,
  explicitActiveWindowMs = DEFAULT_EXPLICIT_ACTIVE_WINDOW_MS,
  completedWindowMs = DEFAULT_COMPLETED_WINDOW_MS,
  tailBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return { status: "idle", activeSessions: 0, updatedAt: null, source: "local-rollout-events" };
  const candidates = files ?? await recentFiles(codexHome, new Date(nowMs), lookbackMs);
  const summaries = (await Promise.all(candidates.map((filePath) => summarizeFile(filePath, nowMs, {
    lookbackMs,
    activeWindowMs,
    explicitActiveWindowMs,
    completedWindowMs,
    tailBytes,
  })))).filter(Boolean);

  const waiting = summaries.filter((item) => item.kind === "waiting");
  const running = summaries.filter((item) => item.kind === "running");
  const completed = summaries.filter((item) => item.kind === "completed");
  const selected = waiting[0] ?? running[0] ?? completed.sort((first, second) => second.timestampMs - first.timestampMs)[0] ?? null;
  const status = selected?.kind ?? "idle";
  return {
    status,
    activeSessions: waiting.length + running.length,
    updatedAt: selected ? new Date(selected.timestampMs).toISOString() : null,
    source: "local-rollout-events",
  };
}
