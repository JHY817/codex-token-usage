import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { UsageService } from "./service.mjs";
import { readCreditsSummary } from "./credits.mjs";
import { readQuota } from "./quota.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_URI = "ui://codex-token-usage/dashboard-v1.html";
const RANGE_SCHEMA = z.enum(["today", "7d", "30d", "all"]).default("today");
const CONVERSATION_ID_SCHEMA = z.string().trim().min(1).max(160);
const CONVERSATION_IDS_SCHEMA = z.array(CONVERSATION_ID_SCHEMA).min(1).max(20);
const service = new UsageService();
let officialQuotaCache = null;
let officialQuotaPending = null;
async function getOfficialQuota(force) {
  if (!force && officialQuotaCache && Date.now() - officialQuotaCache.at < (officialQuotaCache.value.available ? 300_000 : 5_000)) return officialQuotaCache.value;
  if (officialQuotaPending) return officialQuotaPending;
  officialQuotaPending = readQuota().then((value) => { officialQuotaCache = { at: Date.now(), value }; return value; }).finally(() => { officialQuotaPending = null; });
  return officialQuotaPending;
}

function dashboardHtml() {
  const script = readFileSync(path.join(ROOT, "ui", "dist", "mcp", "component.js"), "utf8");
  const style = readFileSync(path.join(ROOT, "ui", "dist", "mcp", "component.css"), "utf8");
  return `<style>${style}</style><div id="root"></div><script>${script}</script>`;
}

function conciseSummary(dashboard) {
  const modelSummary = dashboard.models
    .slice(0, 6)
    .map((model) => `${model.label}: ${model.tokens.toLocaleString("zh-CN")}`)
    .join("；");
  return `${dashboard.periodLabel}本地可归因 Token 为 ${dashboard.totals.tokens.toLocaleString("zh-CN")}，${dashboard.totals.conversations} 个对话，${dashboard.totals.toolCalls} 次工具调用。${modelSummary}`;
}

function safeDashboardSummary(dashboard) {
  return {
    range: dashboard.range,
    periodLabel: dashboard.periodLabel,
    generatedAt: dashboard.generatedAt,
    totals: dashboard.totals,
    models: dashboard.models.map(({ id, label, tokens, share }) => ({ id, label, tokens, share })),
    caveat: "local attribution, not billing",
  };
}

function privateDashboardResult(dashboard, text) {
  return {
    structuredContent: { summary: safeDashboardSummary(dashboard) },
    content: [{ type: "text", text }],
    _meta: { dashboard },
  };
}

const APP_ONLY_META = {
  ui: { visibility: ["app"] },
  "openai/visibility": "private",
};

const server = new McpServer(
  { name: "codex-token-usage", version: "0.1.5" },
  {
    instructions:
      "This local-only server reads Codex session logs for usage attribution. Never describe its totals as billing data or calculate USD cost. Use open_usage_dashboard for visual inspection and get_usage_summary for short questions. The all range covers currently retained local session logs and is rebuilt from a persistent aggregate index.",
  },
);

registerAppResource(
  server,
  "codex-token-usage-dashboard",
  TEMPLATE_URI,
  {},
  async () => ({
    contents: [
      {
        uri: TEMPLATE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: dashboardHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      },
    ],
  }),
);

server.registerTool(
  "get_official_usage_summary",
  {
    title: "查询官方 credits 消耗与额度",
    description: "读取官方 credits 消耗与套餐额度；缺失消耗保持未知，不由本地 Token 换算。",
    inputSchema: { range: RANGE_SCHEMA, refresh: z.boolean().default(false), force: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ range, refresh, force }) => {
    const shouldRefresh = refresh || force;
    const [officialUsage, quota] = await Promise.all([readCreditsSummary(range, { force: shouldRefresh }), getOfficialQuota(shouldRefresh)]);
    return { structuredContent: { officialUsage, quota }, content: [{ type: "text", text: officialUsage.available ? `官方 credits 消耗：${officialUsage.totalCredits}` : officialUsage.error }] };
  },
);

server.registerTool(
  "get_usage_summary",
  {
    title: "查询 Codex 使用摘要",
    description: "查询今天、最近 7 天、最近 30 天或累计的本地 Token 使用摘要，不打开可视化看板。累计范围覆盖当前仍保留的本机会话日志，不代表官方账单。",
    inputSchema: { range: RANGE_SCHEMA },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ range }) => {
    const dashboard = await service.getDashboard(range);
    return {
      structuredContent: safeDashboardSummary(dashboard),
      content: [{ type: "text", text: conciseSummary(dashboard) }],
    };
  },
);

server.registerTool(
  "get_usage_snapshot",
  {
    title: "读取 Codex 使用快照",
    description: "读取插件已保存的本地使用快照，供看板在切换今天、7 天、30 天和累计时使用。累计范围按本地索引增量重建。",
    inputSchema: { range: RANGE_SCHEMA },
    _meta: APP_ONLY_META,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ range }) => {
    const dashboard = await service.getDashboard(range);
    return privateDashboardResult(dashboard, conciseSummary(dashboard));
  },
);

server.registerTool(
  "refresh_usage_snapshot",
  {
    title: "刷新 Codex 使用快照",
    description: "重新扫描本机 Codex 会话事件并覆盖当前周期快照；用于看板中的手动刷新。累计范围只重解析新增或发生变化的 rollout 文件。",
    inputSchema: { range: RANGE_SCHEMA },
    _meta: APP_ONLY_META,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  async ({ range }) => {
    const dashboard = await service.refreshDashboard(range);
    return privateDashboardResult(dashboard, `已刷新。${conciseSummary(dashboard)}`);
  },
);

server.registerTool(
  "get_conversation_usage_detail",
  {
    title: "查询任务 Token 明细",
    description: "查询一个本地任务按模型与思考档位拆分的今日 Token 与本机累计 Token 对比。累计范围覆盖当前仍保留的本机会话日志，不代表官方账单。",
    inputSchema: { conversationId: CONVERSATION_ID_SCHEMA },
    _meta: APP_ONLY_META,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ conversationId }) => {
    const detail = await service.getConversationUsageDetail(conversationId);
    const modelSummary = detail.models
      .slice(0, 6)
      .map((model) => `${model.label}: 今日 ${model.todayTokens.toLocaleString("zh-CN")}，累计 ${model.cumulativeTokens.toLocaleString("zh-CN")}`)
      .join("；");
    return {
      structuredContent: {
        todayTokens: detail.todayTokens,
        cumulativeTokens: detail.cumulativeTokens,
        modelCount: detail.models.length,
        caveat: "local attribution, not billing",
      },
      content: [{
        type: "text",
        text: `该任务今日 ${detail.todayTokens.toLocaleString("zh-CN")} Token，累计 ${detail.cumulativeTokens.toLocaleString("zh-CN")} Token。${modelSummary}`,
      }],
      _meta: { detail },
    };
  },
);

server.registerTool(
  "get_conversation_usage_totals",
  {
    title: "查询任务累计 Token",
    description: "批量查询最多 20 个本地任务的累计 Token。累计范围覆盖当前仍保留的本机会话日志，不代表官方账单；未知任务返回 0。",
    inputSchema: { conversationIds: CONVERSATION_IDS_SCHEMA },
    _meta: APP_ONLY_META,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ conversationIds }) => {
    const { totals, cumulativeBreakdowns } = await service.getConversationUsageTotals(conversationIds, new Date(), { includeBreakdowns: true });
    const totalTokens = Object.values(totals).reduce((sum, tokens) => sum + tokens, 0);
    return {
      structuredContent: {
        conversationCount: Object.keys(totals).length,
        totalTokens,
        caveat: "local attribution, not billing",
      },
      content: [{ type: "text", text: `已查询 ${Object.keys(totals).length} 个任务的累计 Token。` }],
      _meta: { totals, cumulativeBreakdowns },
    };
  },
);

server.registerTool(
  "open_usage_dashboard",
  {
    title: "打开 Codex Token Usage",
    description: "打开交互式全屏使用看板，展示模型 × 思考档位、趋势和对话分析。",
    inputSchema: { range: RANGE_SCHEMA },
    _meta: {
      ui: { resourceUri: TEMPLATE_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": TEMPLATE_URI,
      "openai/toolInvocation/invoking": "正在读取本地使用快照…",
      "openai/toolInvocation/invoked": "使用洞察已就绪。",
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ range }) => {
    const dashboard = await service.getDashboard(range);
    return privateDashboardResult(dashboard, conciseSummary(dashboard));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

const close = () => {
  service.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
