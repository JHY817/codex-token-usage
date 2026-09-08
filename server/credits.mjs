import { spawn } from "node:child_process";
import { getAppServerCommand } from "./quota.mjs";

const cache = new Map();
const TTL = 60_000;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const creditNumber = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value / 1_000_000 : null;
const base = (now) => ({ available: false, source: "codex-app-server", fetchedAt: now.toISOString(), error: null, timeZone });

export function normalizeConversationCredits(payload, id, now = new Date()) {
  const result = payload?.result ?? payload;
  const usage = result?.threadUsage;
  const valid = usage?.threadId === id;
  const cumulativeCredits = valid ? creditNumber(usage.estimatedUsageCreditsMicros) : null;
  const models = new Map();
  if (valid && Array.isArray(usage.groups)) for (const group of usage.groups) {
    const model = typeof group.model === "string" && group.model ? group.model : "unknown";
    const effort = typeof group.reasoningEffort === "string" && group.reasoningEffort ? group.reasoningEffort : "unknown";
    const key = `${model}|${effort}`;
    const credits = creditNumber(group.estimatedUsageCreditsMicros);
    const previous = models.get(key);
    models.set(key, { id: key, label: `${model} · ${effort}`, todayCredits: null,
      cumulativeCredits: previous ? (previous.cumulativeCredits === null || credits === null ? null : previous.cumulativeCredits + credits) : credits });
  }
  return { ...base(now), available: cumulativeCredits !== null,
    error: cumulativeCredits === null ? "官方未返回该任务的 credits 消耗" : null,
    todayCredits: null, cumulativeCredits, models: [...models.values()],
    estimated: true,
    coverage: { complete: false, start: null, end: now.toISOString(), cumulativeComplete: cumulativeCredits !== null,
      todayComplete: false, reason: "官方任务接口仅返回累计估计消耗，未提供按日明细" } };
}

// Only the existing local authenticated App Server is used. No credentials are
// read, copied, or logged, and no thread/model turn is started.
export function readThreadUsage(id, { spawnImpl = spawn, timeoutMs = 10_000, codexHome } = {}) {
  return new Promise((resolve) => {
    const spec = getAppServerCommand({ codexHome });
    let child, buffer = "", settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { child?.kill("SIGTERM"); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: "credits 读取超时" }), timeoutMs);
    try { child = spawnImpl(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }); }
    catch { finish({ error: "无法启动 Codex credits 读取" }); return; }
    const send = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish({ error: "credits 连接不可用" }); } };
    const line = (text) => {
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (String(message.id) === "1") {
        if (message.error) { finish({ error: "App Server 初始化失败" }); return; }
        send({ method: "initialized", params: {} });
        send({ method: "account/usage/read", id: 2, params: { threadId: id } });
      }
      if (String(message.id) === "2") finish(message.error ? { error: "官方暂不支持或无法读取该任务的 credits" } : { payload: message.result });
    };
    child.stdout.on("data", (chunk) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(line); });
    child.stdout.on("end", () => { if (buffer) line(buffer); });
    child.stderr.on("data", () => {});
    child.on("error", () => finish({ error: "无法连接 Codex App Server" }));
    child.on("close", () => finish({ error: "credits 连接已结束" }));
    send({ method: "initialize", id: 1, params: { clientInfo: { name: "codex-token-usage", version: "0.1.5" } } });
  });
}

export async function readConversationCredits(id, { force = false, reader = readThreadUsage } = {}) {
  if (typeof id !== "string" || !id.trim()) return { ...normalizeConversationCredits(null, id), error: "缺少任务 ID" };
  const existing = cache.get(id);
  if (existing?.pending) return existing.pending;
  if (!force && existing && Date.now() - existing.at < TTL) return existing.value;
  const pending = (async () => {
    let response;
    try { response = await reader(id); } catch { response = { error: "credits 读取失败" }; }
    const value = normalizeConversationCredits(response.payload, id);
    if (response.error) value.error = response.error;
    cache.set(id, { at: Date.now(), value });
    // Bound the in-memory cache; it stores only usage, never credentials.
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  })();
  cache.set(id, { pending });
  return pending;
}

export async function readCreditsSummary(range = "today", { force = false } = {}) {
  const now = new Date();
  // Account App Server schema exposes tokens only. Private billing endpoints
  // have no supported authenticated transport here. Do not convert tokens or
  // add local task lifetimes and label that as complete account consumption.
  return { ...base(now), range, periodStart: null, periodEnd: now.toISOString(),
    totalCredits: null, models: [], daily: [],
    coverage: { complete: false, start: null, end: null },
    error: "官方账号接口未提供 credits 消耗；今日、7 天、30 天和累计暂不可用" };
}
