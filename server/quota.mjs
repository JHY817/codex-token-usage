import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLIENT_INFO = {
  name: "codex-token-usage",
  title: "Codex Token Usage",
  version: "0.1.0",
};

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function firstNumber(object, keys) {
  for (const key of keys) {
    const value = finiteNumber(object?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function percentage(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 100) return null;
  return number;
}

function unixSeconds(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  // The public protocol uses Unix seconds. Accept millisecond timestamps from
  // older/local wrappers without exposing a misleading reset time.
  return number > 100_000_000_000 ? number / 1_000 : number;
}

function positiveInteger(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return Math.round(number);
}

function nestedWindow(record, bucket) {
  const raw = record?.[bucket];
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = percentage(
    raw.usedPercent
      ?? raw.used_percent
      ?? raw.percentUsed
      ?? raw.percent_used
      ?? raw.used,
  );
  if (usedPercent === null) return null;
  const windowDurationMins = positiveInteger(
    raw.windowDurationMins
      ?? raw.window_duration_mins
      ?? raw.windowDuration
      ?? raw.window_duration,
  );
  const resetsAt = unixSeconds(raw.resetsAt ?? raw.resets_at ?? raw.resetAt ?? raw.reset_at);
  return {
    bucket,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowDurationMins,
    resetsAt,
    resetsAtIso: resetsAt === null ? null : new Date(resetsAt * 1_000).toISOString(),
  };
}

function mergeRecord(target, source) {
  const output = { ...target, ...source };
  for (const key of ["primary", "secondary"]) {
    if (target?.[key] || source?.[key]) output[key] = { ...(target?.[key] ?? {}), ...(source?.[key] ?? {}) };
  }
  return output;
}

function limitRecords(result) {
  const records = new Map();
  const add = (key, value) => {
    if (!value || typeof value !== "object") return;
    const limitId = String(value.limitId ?? key ?? "codex");
    records.set(limitId, mergeRecord(records.get(limitId), { ...value, limitId }));
  };

  const byLimitId = result?.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    for (const [key, value] of Object.entries(byLimitId)) add(key, value);
  }
  if (result?.rateLimits && typeof result.rateLimits === "object") {
    add(result.rateLimits.limitId ?? "codex", result.rateLimits);
  }
  return records;
}

/**
 * Convert the app-server result into a small, stable shape for the native app
 * and local HTTP endpoint. Only server-reported percentages are accepted;
 * local token totals are deliberately not used as a quota fallback.
 */
export function normalizeRateLimits(payload, fetchedAt = new Date()) {
  const result = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const windows = [];
  const seen = new Set();

  for (const [key, record] of limitRecords(result).entries()) {
    const limitId = String(record.limitId ?? key);
    const limitName = typeof record.limitName === "string" && record.limitName.trim()
      ? record.limitName.trim()
      : null;
    for (const bucket of ["primary", "secondary"]) {
      const window = nestedWindow(record, bucket);
      if (!window) continue;
      const windowKey = `${limitId}:${bucket}`;
      if (seen.has(windowKey)) continue;
      seen.add(windowKey);
      windows.push({
        limitId,
        limitName,
        ...window,
      });
    }
  }

  windows.sort((left, right) => {
    const remaining = left.remainingPercent - right.remainingPercent;
    if (remaining !== 0) return remaining;
    return (right.windowDurationMins ?? 0) - (left.windowDurationMins ?? 0);
  });

  const selected = windows[0] ?? null;
  const resultObject = {
    available: Boolean(selected),
    source: "codex-app-server",
    fetchedAt: fetchedAt instanceof Date ? fetchedAt.toISOString() : new Date(fetchedAt).toISOString(),
    planType: result?.planType ?? selected?.planType ?? null,
    selected: selected ? { ...selected, selectionReason: "most-constrained-window" } : null,
    windows,
    rateLimitReachedType: result?.rateLimitReachedType ?? null,
    resetCredits: result?.rateLimitResetCredits ?? null,
    error: selected ? null : "App Server 未返回可用额度窗口",
  };
  return resultObject;
}

function unavailable(error, fetchedAt = new Date()) {
  const message = error instanceof Error ? error.message : String(error || "额度暂不可用");
  return {
    available: false,
    source: "codex-app-server",
    fetchedAt: fetchedAt.toISOString(),
    planType: null,
    selected: null,
    windows: [],
    rateLimitReachedType: null,
    resetCredits: null,
    error: message,
  };
}

function appServerCommand({ codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex") } = {}) {
  const command = process.env.CODEX_BIN ?? "codex";
  const configuredSocket = process.env.CODEX_APP_SERVER_SOCKET;
  const socketPath = configuredSocket || path.join(codexHome, "app-server-control", "app-server-control.sock");
  if (existsSync(socketPath)) {
    return {
      command,
      args: ["app-server", "proxy", "--sock", socketPath],
      transport: "proxy",
      socketPath,
    };
  }
  return {
    command,
    args: ["app-server", "--stdio"],
    transport: "stdio",
    socketPath: null,
  };
}

export function getAppServerCommand(options = {}) {
  return appServerCommand(options);
}

function safeErrorMessage(error) {
  if (error?.code === "ENOENT") return "找不到 codex 命令";
  if (error?.code === "EACCES") return "无法启动 codex app-server";
  return error instanceof Error ? error.message : String(error || "无法启动 codex app-server");
}

/**
 * Read ChatGPT/Codex quota from the local app-server JSON-RPC endpoint.
 * This invokes no model turn and sends no prompt. The child process is
 * terminated as soon as the rate-limits response arrives.
 */
export function readQuota({
  spawnImpl = nodeSpawn,
  command,
  args,
  timeoutMs = Number(process.env.CODEX_USAGE_QUOTA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  clientInfo = DEFAULT_CLIENT_INFO,
  codexHome,
} = {}) {
  const spec = command
    ? { command, args: args ?? ["app-server", "--stdio"], transport: "custom" }
    : appServerCommand({ codexHome });
  const fetchedAt = new Date();

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buffer = "";
    let killTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      try {
        child?.kill?.("SIGTERM");
        if (child && !child.killed) {
          killTimer = setTimeout(() => child.kill?.("SIGKILL"), 250);
          killTimer.unref?.();
        }
      } catch {
        // A process can exit between the response and cleanup.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(unavailable("额度读取超时", fetchedAt)), Math.max(100, timeoutMs));

    try {
      child = spawnImpl(spec.command, spec.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (error) {
      finish(unavailable(safeErrorMessage(error), fetchedAt));
      return;
    }

    const send = (message) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(unavailable(safeErrorMessage(error), fetchedAt));
      }
    };

    const handleLine = (line) => {
      if (settled || !line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (String(message?.id) !== "2") return;
      if (message.error) {
        const detail = message.error.message ?? "App Server 拒绝额度读取";
        finish(unavailable(detail, fetchedAt));
        return;
      }
      finish(normalizeRateLimits(message.result ?? {}, fetchedAt));
    };

    child.stdout?.on?.("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stdout?.on?.("end", () => {
      if (buffer) handleLine(buffer);
    });
    // Drain diagnostics so a noisy CLI cannot block its stdout response pipe.
    child.stderr?.on?.("data", () => {});
    child.on?.("error", (error) => finish(unavailable(safeErrorMessage(error), fetchedAt)));
    child.on?.("close", (code, signal) => {
      if (!settled) {
        const detail = signal ? `codex app-server 被 ${signal} 终止` : `codex app-server 退出（${code ?? "未知状态"}）`;
        finish(unavailable(detail, fetchedAt));
      }
    });

    // Keep the handshake and request read-only. `initialized` is a
    // notification; account/rateLimits/read does not start a thread or turn.
    send({ method: "initialize", id: 1, params: { clientInfo } });
    send({ method: "initialized", params: {} });
    send({ method: "account/rateLimits/read", id: 2, params: {} });
  });
}

export const getQuota = readQuota;
