let requestId = 1;
const pending = new Map();

function objectValue(value) {
  return value && typeof value === "object" ? value : null;
}

export function getPrivateToolPayload(value) {
  const queue = [objectValue(value)].filter(Boolean);
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const meta = objectValue(current._meta);
    if (meta && (
      meta.dashboard
      || meta.detail
      || meta.totals
      || meta.cumulativeBreakdowns
      || meta.officialUsage
      || meta.quota
    )) return meta;
    for (const key of [
      "result",
      "params",
      "call_tool_result",
      "mcp_tool_result",
      "toolResponseMetadata",
      "_meta",
    ]) {
      const nested = objectValue(current[key]);
      if (nested) queue.push(nested);
    }
  }
  return null;
}

function isHostResult(value) {
  return value && typeof value === "object" && (value.structuredContent || value.content || value.dashboard || value._meta);
}

async function callLocalPreview(name, args) {
  if (name === "get_conversation_usage_totals") {
    const conversationIds = Array.isArray(args?.conversationIds) ? args.conversationIds : [];
    const params = new URLSearchParams({ conversationIds: JSON.stringify(conversationIds) });
    const response = await fetch(`/api/conversation-usage-totals?${params}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.totals || typeof payload.totals !== "object") {
      throw new Error(payload?.error ?? `本地数据服务返回 ${response.status}`);
    }
    return { structuredContent: { totals: payload.totals, cumulativeBreakdowns: payload.cumulativeBreakdowns ?? {} } };
  }

  if (name === "get_conversation_usage_detail") {
    const conversationId = String(args?.conversationId ?? "");
    const params = new URLSearchParams({ conversationId });
    const response = await fetch(`/api/conversation-usage?${params}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.detail) {
      throw new Error(payload?.error ?? `本地数据服务返回 ${response.status}`);
    }
    return { structuredContent: { detail: payload.detail } };
  }

  if (name === "get_official_usage_summary") {
    const params = new URLSearchParams({ range: args?.range ?? "today" });
    if (args?.force) params.set("refresh", "1");
    const response = await fetch(`/api/official-usage?${params}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || (!payload?.officialUsage && !payload?.quota)) {
      throw new Error(payload?.error ?? `本地数据服务返回 ${response.status}`);
    }
    return { structuredContent: { officialUsage: payload.officialUsage, quota: payload.quota ?? null } };
  }

  const endpoint = name === "refresh_usage_snapshot" ? "/api/usage/refresh" : "/api/usage";
  const method = name === "refresh_usage_snapshot" ? "POST" : "GET";
  const params = new URLSearchParams({ range: args?.range ?? "today" });
  const response = await fetch(`${endpoint}?${params}`, {
    method,
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.dashboard) {
    throw new Error(payload?.error ?? `本地数据服务返回 ${response.status}`);
  }
  return { structuredContent: { dashboard: payload.dashboard } };
}

export function getInitialDashboard() {
  const privatePayload = getPrivateToolPayload(window.openai?.toolResponseMetadata);
  if (privatePayload?.dashboard) return privatePayload.dashboard;
  const value = window.openai?.toolOutput;
  if (!value) return null;
  return value.dashboard ?? value.structuredContent?.dashboard ?? value.structuredContent ?? value;
}

export function subscribeToToolResults(onResult) {
  function handleMessage(event) {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "工具调用失败"));
      else resolve(message.result);
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      onResult(message.params ?? null);
    }
  }

  window.addEventListener("message", handleMessage, { passive: true });
  return () => window.removeEventListener("message", handleMessage);
}

export async function callTool(name, args) {
  if (window.openai?.callTool) {
    const result = await window.openai.callTool(name, args);
    if (isHostResult(result)) return result;
  }

  if (window.parent === window) return callLocalPreview(name, args);

  const id = requestId++;
  const result = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("工具调用超时"));
    }, 15_000);
  });

  window.parent.postMessage(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    },
    "*",
  );
  return result;
}
