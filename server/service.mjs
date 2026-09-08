import { collectUsage } from "./usage.mjs";
import { SnapshotStore } from "./store.mjs";
import { readConversationCredits, normalizeConversationCredits } from "./credits.mjs";

const MAX_CONVERSATION_ID_LENGTH = 160;
const MAX_CONVERSATION_TOTAL_IDS = 20;

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeConversationId(conversationId) {
  if (typeof conversationId !== "string") {
    const error = new TypeError("conversationId 必须是字符串");
    error.statusCode = 400;
    throw error;
  }
  const normalized = conversationId.trim();
  if (!normalized || normalized.length > MAX_CONVERSATION_ID_LENGTH) {
    const error = new TypeError(`conversationId 不能为空且长度不能超过 ${MAX_CONVERSATION_ID_LENGTH} 个字符`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeConversationIds(conversationIds) {
  if (!Array.isArray(conversationIds) || !conversationIds.length) {
    const error = new TypeError("conversationIds 必须是非空数组");
    error.statusCode = 400;
    throw error;
  }
  if (conversationIds.length > MAX_CONVERSATION_TOTAL_IDS) {
    const error = new TypeError(`conversationIds 最多包含 ${MAX_CONVERSATION_TOTAL_IDS} 个会话`);
    error.statusCode = 400;
    throw error;
  }
  return [...new Set(conversationIds.map(normalizeConversationId))];
}

function safeDisplayText(value, fallback, maxLength = 160) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength) || fallback;
}

function dashboardConversations(dashboard) {
  if (Array.isArray(dashboard?.conversations)) return dashboard.conversations;
  if (Array.isArray(dashboard?.tasks)) return dashboard.tasks;
  return [];
}

function modelUsageMap(conversation) {
  const output = new Map();
  for (const model of Array.isArray(conversation?.modelUsage) ? conversation.modelUsage : []) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
    const id = model.id.trim();
    const tokens = Number(model.tokens);
    output.set(id, {
      id,
      label: safeDisplayText(model.label, id, 120),
      tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : 0,
      share: Number.isFinite(Number(model.share)) && Number(model.share) >= 0 ? Number(model.share) : 0,
      breakdown: model.breakdown ?? null,
    });
  }
  return output;
}

export class UsageService {
  constructor({ store = new SnapshotStore(), collector = collectUsage, creditsReader = readConversationCredits, creditsWaitMs = 750 } = {}) {
    this.store = store;
    this.collector = collector;
    this.creditsReader = creditsReader;
    this.creditsWaitMs = creditsWaitMs;
  }

  async getDashboard(range = "today", now = new Date()) {
    // "all" is rebuilt from the persistent rollout index on every request.
    // The index performs metadata-only checks for unchanged files, so opening
    // the cumulative view stays current without rereading the full history.
    if (range === "all") return this.refreshDashboard(range, now);
    const cached = this.store.loadLatest(range);
    if (cached?.version >= 2 && cached?.periodEnd === localDayKey(now)) {
      return {
        ...cached,
        dataSource: "snapshot",
        quality: {
          ...cached.quality,
          snapshotGeneratedAt: cached.generatedAt,
        },
      };
    }
    return this.refreshDashboard(range, now);
  }

  async refreshDashboard(range = "today", now = new Date()) {
    const dashboard = await this.collector({ range, now, indexStore: this.store });
    return this.store.save(dashboard);
  }

  async getConversationUsageDetail(conversationId, now = new Date(), { force = false } = {}) {
    const normalizedId = normalizeConversationId(conversationId);
    const todayDashboard = await this.getDashboard("today", now);
    const cumulativeDashboard = await this.getDashboard("all", now);
    const todayConversation = dashboardConversations(todayDashboard).find((item) => item?.id === normalizedId);
    const cumulativeConversation = dashboardConversations(cumulativeDashboard).find((item) => item?.id === normalizedId);
    if (!cumulativeConversation) {
      const error = new Error(`未找到任务 ${normalizedId} 的累计 Token 记录`);
      error.statusCode = 404;
      throw error;
    }

    const todayModels = modelUsageMap(todayConversation);
    const cumulativeModels = modelUsageMap(cumulativeConversation);
    const modelIds = new Set([...todayModels.keys(), ...cumulativeModels.keys()]);
    const models = [...modelIds]
      .map((id) => {
        const today = todayModels.get(id);
        const cumulative = cumulativeModels.get(id);
        return {
          id,
          label: cumulative?.label ?? today?.label ?? id,
          todayTokens: today?.tokens ?? 0,
          cumulativeTokens: cumulative?.tokens ?? 0,
          todayShare: today?.share ?? 0,
          cumulativeShare: cumulative?.share ?? 0,
          todayBreakdown: today?.breakdown ?? null,
          cumulativeBreakdown: cumulative?.breakdown ?? null,
        };
      })
      .sort((first, second) => (
        second.cumulativeTokens - first.cumulativeTokens
        || second.todayTokens - first.todayTokens
        || first.label.localeCompare(second.label)
      ));

    const source = todayConversation ?? cumulativeConversation;
    const numericTokens = (value) => {
      const tokens = Number(value);
      return Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
    };
    let credits;
    let creditsTimer;
    const pending = Symbol("pending");
    try {
      credits = await Promise.race([
        Promise.resolve().then(() => this.creditsReader(normalizedId, { force })).catch(() => null),
        new Promise((resolve) => { creditsTimer = setTimeout(() => resolve(pending), this.creditsWaitMs); }),
      ]);
    } finally { clearTimeout(creditsTimer); }
    const stillPending = credits === pending;
    if (!credits || typeof credits !== "object") credits = normalizeConversationCredits(null, normalizedId, now);
    if (stillPending) credits = { ...credits, pending: true, retryAfterMs: 1_500, error: "正在读取官方任务 credits" };
    return {
      credits,
      conversation: {
        id: normalizedId,
        title: safeDisplayText(source?.title, "Codex 对话"),
        projectLabel: safeDisplayText(source?.projectLabel, "未识别项目", 80),
        toolCalls: numericTokens(source?.toolCalls),
        turns: numericTokens(source?.turns),
        childCount: numericTokens(source?.childCount),
      },
      todayTokens: numericTokens(todayConversation?.tokens),
      cumulativeTokens: numericTokens(cumulativeConversation?.tokens),
      todayBreakdown: todayConversation?.breakdown ?? null,
      cumulativeBreakdown: cumulativeConversation?.breakdown ?? null,
      models,
    };
  }

  async getConversationUsageTotals(conversationIds, now = new Date(), { includeBreakdowns = false } = {}) {
    const normalizedIds = normalizeConversationIds(conversationIds);
    const cumulativeDashboard = await this.getDashboard("all", now);
    const cumulativeConversations = dashboardConversations(cumulativeDashboard);
    const cumulativeById = new Map(
      cumulativeConversations
        .filter((conversation) => typeof conversation?.id === "string")
        .map((conversation) => [conversation.id, conversation]),
    );
    const numericTokens = (value) => {
      const tokens = Number(value);
      return Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
    };
    const totals = Object.fromEntries(normalizedIds.map((id) => [
      id,
      numericTokens(cumulativeById.get(id)?.tokens),
    ]));
    if (!includeBreakdowns) return totals;
    return {
      totals,
      cumulativeBreakdowns: Object.fromEntries(normalizedIds.map((id) => [id, cumulativeById.get(id)?.breakdown ?? null])),
    };
  }

  close() {
    this.store.close();
  }
}
