import { spawn as defaultSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const WAITING_FLAGS = new Set(["waitingonapproval", "waitingonuserinput"]);
const WAITING_METHODS = new Set([
  "item/commandexecution/requestapproval",
  "item/filechange/requestapproval",
  "item/permissions/requestapproval",
  "item/tool/requestuserinput",
]);
const DEFAULT_COMPLETED_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 5 * 1_000;
const DEFAULT_DISCOVERY_DELAY_MS = 15 * 1_000;

function normalized(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function timestampMs(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isoTimestamp(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function threadIdFrom(params = {}) {
  if (typeof params.threadId === "string" && params.threadId.trim()) return params.threadId;
  if (typeof params.thread?.id === "string" && params.thread.id.trim()) return params.thread.id;
  if (typeof params.turn?.threadId === "string" && params.turn.threadId.trim()) return params.turn.threadId;
  if (typeof params.item?.threadId === "string" && params.item.threadId.trim()) return params.item.threadId;
  return null;
}

function statusKind(status) {
  const type = normalized(status?.type);
  const flags = Array.isArray(status?.activeFlags)
    ? status.activeFlags.map(normalized)
    : [];
  if (flags.some((flag) => WAITING_FLAGS.has(flag))) return "waiting";
  if (type === "active" || type === "running" || type === "inprogress") return "running";
  if (type === "idle") return "idle";
  return null;
}

function activeStatus(status) {
  return statusKind(status) === "running" || statusKind(status) === "waiting";
}

/**
 * Reduce per-thread runtime states into the single menu-bar state. This is
 * deliberately independent from transport so it can be tested with captured
 * app-server notifications and used by alternative hosts.
 */
export function reduceBridgeStatus(threads, {
  now = new Date(),
  completedWindowMs = DEFAULT_COMPLETED_WINDOW_MS,
  source = "codex-app-server",
  bridge = "connected",
  error = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : timestampMs(now);
  const entries = threads instanceof Map ? [...threads.values()] : Array.isArray(threads) ? threads : [];
  const active = entries.filter((entry) => entry?.state === "running" || entry?.state === "waiting");
  const waiting = active.filter((entry) => entry.state === "waiting");
  const recentCompleted = entries
    .filter((entry) => entry?.state === "completed" && Number.isFinite(entry.completedAtMs))
    .filter((entry) => nowMs - entry.completedAtMs <= completedWindowMs)
    .sort((a, b) => b.completedAtMs - a.completedAtMs)[0];

  if (waiting.length) {
    return {
      available: true,
      status: "waiting",
      activeSessions: active.length,
      updatedAt: isoTimestamp(Math.max(...waiting.map((entry) => entry.updatedAtMs || 0))),
      source,
      bridge,
      error,
    };
  }
  if (active.length) {
    return {
      available: true,
      status: "running",
      activeSessions: active.length,
      updatedAt: isoTimestamp(Math.max(...active.map((entry) => entry.updatedAtMs || 0))),
      source,
      bridge,
      error,
    };
  }
  if (recentCompleted) {
    return {
      available: true,
      status: "completed",
      activeSessions: 0,
      updatedAt: isoTimestamp(recentCompleted.completedAtMs),
      source,
      bridge,
      error,
    };
  }
  return {
    available: true,
    status: "idle",
    activeSessions: 0,
    updatedAt: null,
    source,
    bridge,
    error,
  };
}

/**
 * Merge the structured source with the existing rollout scanner. A bridge
 * that has not observed a runtime thread must not hide a useful local fallback
 * (this is important while the desktop host keeps its app-server private).
 */
export function mergeActivityStatus(localActivity, bridgeActivity) {
  if (bridgeActivity?.available === true && bridgeActivity?.bridge === "connected") {
    return bridgeActivity;
  }
  return localActivity;
}

export async function findAppServerSocket({
  codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  socketPath = process.env.CODEX_APP_SERVER_SOCKET,
} = {}) {
  const candidates = [
    socketPath,
    path.join(codexHome, "app-server-control", "app-server-control.sock"),
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isSocket()) return candidate;
    } catch {
      // The socket is optional. The caller keeps the rollout fallback active.
    }
  }
  return null;
}

export class CodexStatusBridge {
  constructor({
    enabled = process.env.CODEX_USAGE_STATUS_BRIDGE !== "off",
    codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    socketPath = process.env.CODEX_APP_SERVER_SOCKET,
    codexBin = process.env.CODEX_BIN || "codex",
    spawnFn = defaultSpawn,
    now = () => Date.now(),
    reconnectDelayMs = Number(process.env.CODEX_STATUS_BRIDGE_RECONNECT_MS) || DEFAULT_RECONNECT_DELAY_MS,
    discoveryDelayMs = Number(process.env.CODEX_STATUS_BRIDGE_DISCOVERY_MS) || DEFAULT_DISCOVERY_DELAY_MS,
    completedWindowMs = DEFAULT_COMPLETED_WINDOW_MS,
    onChange = () => {},
  } = {}) {
    this.enabled = enabled;
    this.codexHome = codexHome;
    this.socketPath = socketPath;
    this.codexBin = codexBin;
    this.spawnFn = spawnFn;
    this.now = now;
    this.reconnectDelayMs = Math.max(250, reconnectDelayMs);
    this.discoveryDelayMs = Math.max(1_000, discoveryDelayMs);
    this.completedWindowMs = completedWindowMs;
    this.onChange = onChange;
    this.threads = new Map();
    this.pendingRequests = new Map();
    this.buffer = "";
    this.process = null;
    this.reconnectTimer = null;
    this.discoveryTimer = null;
    this.stopped = true;
    this.connected = false;
    this.hasRuntimeState = false;
    this.lastError = null;
    this.requestId = 0;
    this.listRequestId = null;
  }

  async start() {
    if (!this.enabled || !this.stopped) return false;
    this.stopped = false;
    await this.connectIfAvailable();
    return true;
  }

  async connectIfAvailable() {
    if (this.stopped || this.process) return false;
    const socket = await findAppServerSocket({ codexHome: this.codexHome, socketPath: this.socketPath });
    if (!socket) {
      this.scheduleDiscovery();
      return false;
    }
    this.socketPath = socket;
    try {
      const child = this.spawnFn(this.codexBin, ["app-server", "proxy", "--sock", socket], {
        stdio: ["pipe", "pipe", "ignore"],
        env: process.env,
      });
      this.process = child;
      this.buffer = "";
      this.connected = true;
      this.lastError = null;
      child.stdout?.on("data", (chunk) => this.consume(chunk));
      child.on("error", (error) => this.handleDisconnect(error));
      child.on("close", (code, signal) => {
        if (this.process === child) {
          this.handleDisconnect(new Error(`app-server bridge exited (${code ?? signal ?? "unknown"})`));
        }
      });
      this.send({
        method: "initialize",
        id: ++this.requestId,
        params: {
          clientInfo: {
            name: "codex-token-usage",
            title: "Codex Token Usage status bridge",
            version: "0.1.5",
          },
          capabilities: { experimentalApi: true },
        },
      });
      this.send({ method: "initialized" });
      this.listRequestId = ++this.requestId;
      this.send({
        method: "thread/list",
        id: this.listRequestId,
        params: { limit: 100, archived: false, sortKey: "updated_at", sortDirection: "desc" },
      });
      return true;
    } catch (error) {
      this.handleDisconnect(error);
      return false;
    }
  }

  scheduleDiscovery() {
    if (this.discoveryTimer || this.stopped) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      void this.connectIfAvailable();
    }, this.discoveryDelayMs);
    this.discoveryTimer.unref?.();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectIfAvailable();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  send(message) {
    if (!this.process?.stdin?.writable) return false;
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this.handleDisconnect(error);
      return false;
    }
  }

  consume(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch {
        // A malformed line must not stop the status bridge stream.
      }
    }
  }

  ingest(message, at = this.now()) {
    if (!message || typeof message !== "object") return false;
    const nowMs = timestampMs(at);
    if (message.id === this.listRequestId && Array.isArray(message.result?.data)) {
      for (const thread of message.result.data) this.ingestThread(thread, nowMs);
      if (message.result.data.some((thread) => activeStatus(thread?.status) || normalized(thread?.status?.type) === "idle")) {
        this.hasRuntimeState = true;
      }
      this.emitChange();
      return true;
    }

    const method = normalized(message.method);
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const threadId = threadIdFrom(params);
    if (method === "thread/status/changed" && threadId) {
      this.hasRuntimeState = true;
      const statusType = normalized(params.status?.type);
      if (statusType === "notloaded" || statusType === "systemerror") {
        this.threads.delete(threadId);
        this.emitChange();
        return true;
      }
      this.ingestThread({ id: threadId, status: params.status }, nowMs);
      this.emitChange();
      return true;
    }
    if (method === "thread/started" && threadId) {
      this.hasRuntimeState = true;
      this.setThreadState(threadId, statusKind(params.thread?.status) || "running", nowMs);
      this.emitChange();
      return true;
    }
    if (method === "thread/closed" && threadId) {
      this.threads.delete(threadId);
      this.emitChange();
      return true;
    }
    if (method === "turn/started" && threadId) {
      this.hasRuntimeState = true;
      this.setThreadState(threadId, "running", nowMs);
      this.emitChange();
      return true;
    }
    if (method === "turn/completed" && threadId) {
      this.hasRuntimeState = true;
      this.setThreadState(threadId, "completed", nowMs);
      this.emitChange();
      return true;
    }
    if (WAITING_METHODS.has(method) && threadId) {
      this.hasRuntimeState = true;
      const requestId = params.requestId ?? message.id ?? params.itemId ?? `${threadId}:${nowMs}`;
      this.pendingRequests.set(String(requestId), threadId);
      this.setThreadState(threadId, "waiting", nowMs);
      this.emitChange();
      return true;
    }
    if (method === "serverrequest/resolved") {
      const requestId = params.requestId ?? message.id;
      const resolvedThreadId = (requestId !== undefined && this.pendingRequests.get(String(requestId))) || threadId;
      if (requestId !== undefined) this.pendingRequests.delete(String(requestId));
      if (resolvedThreadId && ![...this.pendingRequests.values()].includes(resolvedThreadId)) {
        this.setThreadState(resolvedThreadId, "running", nowMs);
        this.emitChange();
      }
      return true;
    }
    return false;
  }

  ingestThread(thread, at = this.now()) {
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) return false;
    const kind = statusKind(thread.status);
    if (kind === "waiting" || kind === "running") {
      this.setThreadState(threadId, kind, timestampMs(at));
    } else if (kind === "idle") {
      const current = this.threads.get(threadId);
      const hadActiveTurn = current?.state === "running" || current?.state === "waiting" || current?.state === "completed";
      this.setThreadState(threadId, hadActiveTurn ? "completed" : "idle", timestampMs(at));
    }
    return true;
  }

  setThreadState(threadId, state, at = this.now()) {
    const atMs = timestampMs(at);
    const current = this.threads.get(threadId);
    if (state === "idle") {
      this.threads.set(threadId, { state: "idle", updatedAtMs: atMs, completedAtMs: null });
      return;
    }
    if (state === "completed") {
      this.threads.set(threadId, { state, updatedAtMs: atMs, completedAtMs: atMs });
      return;
    }
    this.threads.set(threadId, {
      state,
      updatedAtMs: atMs,
      completedAtMs: null,
      previousState: current?.state ?? null,
    });
  }

  emitChange() {
    try { this.onChange(this.getSnapshot()); } catch { /* observer errors must not stop the bridge */ }
  }

  getSnapshot({ now = new Date() } = {}) {
    if (!this.hasRuntimeState) {
      return {
        available: false,
        status: "idle",
        activeSessions: 0,
        updatedAt: null,
        source: "codex-app-server",
        bridge: this.connected ? "connected-no-runtime-state" : "unavailable",
        error: this.lastError,
      };
    }
    return reduceBridgeStatus(this.threads, {
      now,
      completedWindowMs: this.completedWindowMs,
      source: "codex-app-server",
      bridge: this.connected ? "connected" : "disconnected",
      error: this.lastError,
    });
  }

  handleDisconnect(error) {
    const child = this.process;
    this.process = null;
    this.connected = false;
    this.lastError = error instanceof Error ? error.message : String(error || "状态桥连接已断开");
    if (child && !child.killed) {
      try { child.kill(); } catch { /* process may already be gone */ }
    }
    this.emitChange();
    this.scheduleReconnect();
  }

  stop() {
    this.stopped = true;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.discoveryTimer = null;
    this.reconnectTimer = null;
    const child = this.process;
    this.process = null;
    this.connected = false;
    if (child && !child.killed) {
      try { child.kill(); } catch { /* process may already be gone */ }
    }
  }
}

export function createStatusBridge(options = {}) {
  return new CodexStatusBridge(options);
}
