import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startUsageHttpServer } from "../http.mjs";
import { UsageService } from "../service.mjs";

test("HTTP exposes model and cumulative task cache denominators without losing unknowns", async () => {
  const breakdown = { inputTokens: 100, cachedInputTokens: 9, cacheTokensKnown: true };
  const service = new UsageService({ store: { close() {} } });
  service.getDashboard = async (range) => ({ ...dashboard(range, 100),
    models: [{ id: "model", label: "Model", tokens: 100, breakdown }],
    conversations: [{ id: "task", tokens: 100, breakdown }] });
  const app = await startUsageHttpServer({ port: 0, service,
    quotaReader: async () => ({ available: false }) });
  try {
    const status = await (await fetch(`${app.url}/api/status`)).json();
    assert.deepEqual(status.models[0].breakdown, breakdown);
    const params = new URLSearchParams({ conversationIds: JSON.stringify(["task", "missing"]) });
    const batch = await (await fetch(`${app.url}/api/conversation-usage-totals?${params}`)).json();
    assert.deepEqual(batch, { totals: { task: 100, missing: 0 }, cumulativeBreakdowns: { task: breakdown, missing: null } });
  } finally { await app.close(); }
});

function dashboard(range, tokens, periodEnd = "2026-08-29") {
  return {
    range,
    periodLabel: range === "today" ? "今天" : range === "all" ? "累计" : "最近 7 天",
    generatedAt: "2026-08-29T10:00:00.000Z",
    dataSource: "local",
    periodStart: periodEnd,
    periodEnd,
    totals: { tokens, conversations: 2, toolCalls: 4 },
    models: [
      {
        id: "gpt-5.6-sol|xhigh",
        label: "GPT-5.6 SOL · 极高",
        tokens: Math.round(tokens * 0.6),
        share: 60,
      },
      {
        id: "gpt-5.6-luna|max",
        label: "GPT-5.6 Luna · Max",
        tokens: Math.round(tokens * 0.4),
        share: 40,
      },
    ],
    chart: [],
    conversations: [],
  };
}

function localTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

test("official usage preserves unknown credits, shares quota cache and forwards refresh", async () => {
  let quotaCalls = 0;
  const requests = [];
  const app = await startUsageHttpServer({ port: 0, service: { close() {} },
    quotaReader: async () => { quotaCalls++; return { available: true, selected: null, windows: [] }; },
    creditsReader: async (range, options) => { requests.push([range, options.force]); return { available: false, totalCredits: null, models: [], error: "missing" }; },
  });
  try {
    const first = await (await fetch(`${app.url}/api/official-usage?range=7d`)).json();
    assert.equal(first.officialUsage.totalCredits, null);
    assert.equal(first.quota.available, true);
    await fetch(`${app.url}/api/official-usage?range=all`);
    assert.equal(quotaCalls, 1);
    await fetch(`${app.url}/api/official-usage?range=today&refresh=1`);
    assert.equal(quotaCalls, 2);
    assert.deepEqual(requests, [["7d", false], ["all", false], ["today", true]]);
    assert.equal((await fetch(`${app.url}/api/official-usage?range=invalid`)).status, 400);
  } finally { await app.close(); }
});

test("official credits failure does not discard available quota", async () => {
  const app = await startUsageHttpServer({ port: 0, service: { close() {} },
    quotaReader: async () => ({ available: true }), creditsReader: async () => { throw Error("failure"); },
  });
  try {
    const response = await fetch(`${app.url}/api/official-usage`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.officialUsage.available, false);
    assert.equal(body.officialUsage.totalCredits, null);
    assert.equal(body.quota.available, true);
  } finally { await app.close(); }
});

test("loopback HTTP host serves dashboard, usage, refresh, and status endpoints", async () => {
  const staticRoot = await mkdtemp(path.join(tmpdir(), "codex-usage-http-"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>usage</title>", "utf8");
  let todayTokens = 100;
  let refreshCalls = 0;
  let quotaCalls = 0;
  let closed = false;
  let nowMs = Date.parse("2026-08-29T10:00:00.000Z");
  const service = {
    async getDashboard(range) {
      return dashboard(range, range === "today" ? todayTokens : 70);
    },
    async refreshDashboard(range) {
      refreshCalls += 1;
      todayTokens += 25;
      return dashboard(range, todayTokens);
    },
    close() {
      closed = true;
    },
  };
  const app = await startUsageHttpServer({
    port: 0,
    staticRoot,
    service,
    now: () => nowMs,
    quotaTtlMs: 100,
    quotaReader: async () => {
      quotaCalls += 1;
      return {
        available: true,
        source: "codex-app-server",
        selected: { limitId: "codex", bucket: "secondary", usedPercent: 12 },
        windows: [],
        error: null,
      };
    },
  });

  try {
    const staticResponse = await fetch(`${app.url}/`);
    assert.equal(staticResponse.status, 200);
    assert.match(await staticResponse.text(), /usage/);

    const usageResponse = await fetch(`${app.url}/api/usage?range=7d`);
    assert.equal(usageResponse.status, 200);
    assert.equal((await usageResponse.json()).dashboard.range, "7d");

    const allResponse = await fetch(`${app.url}/api/usage?range=all`);
    assert.equal(allResponse.status, 200);
    assert.equal((await allResponse.json()).dashboard.range, "all");

    const invalidResponse = await fetch(`${app.url}/api/usage?range=bad`);
    assert.equal(invalidResponse.status, 400);

    const statusResponse = await fetch(`${app.url}/api/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.today.tokens, 100);
    assert.deepEqual(status.models, [
      { id: "gpt-5.6-sol|xhigh", label: "GPT-5.6 SOL · 极高", tokens: 60, share: 60, breakdown: null },
      { id: "gpt-5.6-luna|max", label: "GPT-5.6 Luna · Max", tokens: 40, share: 40, breakdown: null },
    ]);
    assert.equal(status.quota.available, true);
    assert.equal(status.quota.selected.usedPercent, 12);
    assert.equal(status.dataSource, "local");
    assert.equal(quotaCalls, 1);

    const cachedStatusResponse = await fetch(`${app.url}/api/status`);
    assert.equal(cachedStatusResponse.status, 200);
    const cachedStatus = await cachedStatusResponse.json();
    assert.deepEqual(cachedStatus.models, status.models);
    assert.equal(quotaCalls, 1);

    // The quota TTL may expire, but the accepted cadence keeps usage on the
    // same-day snapshot until the user explicitly asks for a refresh.
    nowMs += 10_000;
    const expiredStatusResponse = await fetch(`${app.url}/api/status`);
    assert.equal(expiredStatusResponse.status, 200);
    const expiredStatus = await expiredStatusResponse.json();
    assert.equal(expiredStatus.today.tokens, 100);
    assert.deepEqual(expiredStatus.models, status.models);
    assert.equal(refreshCalls, 0);
    assert.equal(quotaCalls, 2);

    const refreshResponse = await fetch(`${app.url}/api/usage/refresh?range=today`, { method: "POST" });
    assert.equal(refreshResponse.status, 200);
    const refreshedDashboard = await refreshResponse.json();
    assert.equal(refreshedDashboard.dashboard.totals.tokens, 125);
    assert.deepEqual(refreshedDashboard.dashboard.models, [
      { id: "gpt-5.6-sol|xhigh", label: "GPT-5.6 SOL · 极高", tokens: 75, share: 60 },
      { id: "gpt-5.6-luna|max", label: "GPT-5.6 Luna · Max", tokens: 50, share: 40 },
    ]);
    assert.equal(refreshCalls, 1);

    const forcedStatusResponse = await fetch(`${app.url}/api/status?refresh=1`);
    assert.equal(forcedStatusResponse.status, 200);
    const forcedStatus = await forcedStatusResponse.json();
    assert.equal(forcedStatus.today.tokens, 150);
    assert.deepEqual(forcedStatus.models, [
      { id: "gpt-5.6-sol|xhigh", label: "GPT-5.6 SOL · 极高", tokens: 90, share: 60, breakdown: null },
      { id: "gpt-5.6-luna|max", label: "GPT-5.6 Luna · Max", tokens: 60, share: 40, breakdown: null },
    ]);
    assert.equal(quotaCalls, 3);

  } finally {
    await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
  assert.equal(closed, true);
});

test("conversation usage endpoint returns detail and clear 400/404 responses", async () => {
  const staticRoot = await mkdtemp(path.join(tmpdir(), "codex-usage-http-detail-"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>usage</title>", "utf8");
  const detail = {
    conversation: {
      id: "known-task",
      title: "明细任务",
      projectLabel: "usage-plugin",
      toolCalls: 2,
      turns: 1,
      childCount: 0,
    },
    todayTokens: 100,
    cumulativeTokens: 300,
    models: [],
  };
  const service = {
    async getConversationUsageDetail(conversationId, now) {
      assert.ok(now instanceof Date);
      if (typeof conversationId !== "string" || !conversationId.trim()) {
        const error = new TypeError("conversationId 不能为空");
        error.statusCode = 400;
        throw error;
      }
      if (conversationId === "missing-task") return null;
      return detail;
    },
    close() {},
  };
  const app = await startUsageHttpServer({ port: 0, staticRoot, service, now: () => Date.parse("2026-08-29T10:00:00.000Z") });

  try {
    const success = await fetch(`${app.url}/api/conversation-usage?conversationId=known-task`);
    assert.equal(success.status, 200);
    assert.deepEqual((await success.json()).detail, detail);

    const invalid = await fetch(`${app.url}/api/conversation-usage`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /conversationId/);

    const missing = await fetch(`${app.url}/api/conversation-usage?conversationId=missing-task`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /未找到/);
  } finally {
    await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
});

test("conversation usage totals endpoint batches ids and returns clear input errors", async () => {
  const staticRoot = await mkdtemp(path.join(tmpdir(), "codex-usage-http-totals-"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>usage</title>", "utf8");
  let receivedIds = null;
  const service = {
    async getConversationUsageTotals(conversationIds, now) {
      assert.ok(now instanceof Date);
      if (!Array.isArray(conversationIds) || !conversationIds.length) {
        const error = new TypeError("conversationIds 必须是非空数组");
        error.statusCode = 400;
        throw error;
      }
      receivedIds = conversationIds;
      return Object.fromEntries(conversationIds.map((id, index) => [id, (index + 1) * 100]));
    },
    close() {},
  };
  const app = await startUsageHttpServer({
    port: 0,
    staticRoot,
    service,
    now: () => Date.parse("2026-08-29T10:00:00.000Z"),
  });

  try {
    const params = new URLSearchParams({ conversationIds: JSON.stringify(["task-a", "task-b"]) });
    const success = await fetch(`${app.url}/api/conversation-usage-totals?${params}`);
    assert.equal(success.status, 200);
    assert.deepEqual((await success.json()).totals, { "task-a": 100, "task-b": 200 });
    assert.deepEqual(receivedIds, ["task-a", "task-b"]);

    const missing = await fetch(`${app.url}/api/conversation-usage-totals`);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /conversationIds/);

    const malformed = await fetch(`${app.url}/api/conversation-usage-totals?conversationIds=not-json`);
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /JSON 数组/);
  } finally {
    await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
});

test("status degrades to an empty model list when dashboard models are missing", async () => {
  const staticRoot = await mkdtemp(path.join(tmpdir(), "codex-usage-http-status-"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>usage</title>", "utf8");
  const app = await startUsageHttpServer({
    port: 0,
    staticRoot,
    service: {
      async getDashboard() {
        return { ...dashboard("today", 100), models: null };
      },
      close() {},
    },
    quotaReader: async () => ({
      available: false,
      source: "codex-app-server",
      selected: null,
      windows: [],
      error: "额度暂不可用",
    }),
  });

  try {
    const response = await fetch(`${app.url}/api/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.deepEqual(status.models, []);
    assert.equal(status.quota.available, false);
    assert.equal(status.quota.error, "额度暂不可用");
  } finally {
    await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
});

test("quota cache uses a short TTL for unavailable results and keeps the success TTL", async () => {
  const staticRoot = await mkdtemp(path.join(tmpdir(), "codex-usage-http-quota-ttl-"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>usage</title>", "utf8");
  let nowMs = Date.parse("2026-08-29T10:00:00.000Z");
  let quotaCalls = 0;
  let available = false;
  const app = await startUsageHttpServer({
    port: 0,
    staticRoot,
    now: () => nowMs,
    quotaTtlMs: 300_000,
    quotaUnavailableTtlMs: 5_000,
    service: {
      async getDashboard() {
        return dashboard("today", 10);
      },
      close() {},
    },
    quotaReader: async () => {
      quotaCalls += 1;
      return available
        ? {
            available: true,
            source: "codex-app-server",
            selected: { limitId: "codex", bucket: "primary", usedPercent: 20 },
            windows: [],
            error: null,
          }
        : {
            available: false,
            source: "codex-app-server",
            selected: null,
            windows: [],
            error: "额度暂不可用",
          };
    },
  });

  try {
    const first = await fetch(`${app.url}/api/status`);
    assert.equal((await first.json()).quota.available, false);
    assert.equal(quotaCalls, 1);

    nowMs += 4_999;
    const withinUnavailableTtl = await fetch(`${app.url}/api/status`);
    assert.equal((await withinUnavailableTtl.json()).quota.available, false);
    assert.equal(quotaCalls, 1);

    nowMs += 2;
    available = true;
    const afterUnavailableTtl = await fetch(`${app.url}/api/status`);
    assert.equal((await afterUnavailableTtl.json()).quota.available, true);
    assert.equal(quotaCalls, 2);

    nowMs += 299_999;
    const withinSuccessTtl = await fetch(`${app.url}/api/status`);
    assert.equal((await withinSuccessTtl.json()).quota.available, true);
    assert.equal(quotaCalls, 2);

    nowMs += 2;
    const afterSuccessTtl = await fetch(`${app.url}/api/status`);
    assert.equal((await afterSuccessTtl.json()).quota.available, true);
    assert.equal(quotaCalls, 3);
  } finally {
    await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
});

test("ordinary status refreshes the in-memory dashboard after a local day rollover", async () => {
  const staticRoot = await mkdtemp(path.join(tmpdir(), "codex-usage-http-rollover-"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>usage</title>", "utf8");
  let nowMs = localTimestamp(2026, 8, 29, 23, 59, 59);
  let getCalls = 0;
  let rolloverResolve;
  const app = await startUsageHttpServer({
    port: 0,
    staticRoot,
    now: () => nowMs,
    service: {
      async getDashboard() {
        getCalls += 1;
        if (getCalls === 2) {
          return new Promise((resolve) => {
            rolloverResolve = resolve;
          });
        }
        return dashboard("today", 10, "2026-08-29");
      },
      close() {},
    },
    quotaReader: async () => ({
      available: false,
      source: "codex-app-server",
      selected: null,
      windows: [],
      error: "额度暂不可用",
    }),
  });

  try {
    const first = await fetch(`${app.url}/api/status`);
    assert.equal((await first.json()).today.tokens, 10);
    assert.equal(getCalls, 1);

    nowMs = localTimestamp(2026, 8, 30, 0, 0, 1);
    const rolloverResponses = [
      fetch(`${app.url}/api/status`),
      fetch(`${app.url}/api/status`),
    ];
    for (let turns = 0; typeof rolloverResolve !== "function" && turns < 100; turns += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(getCalls, 2);
    assert.equal(typeof rolloverResolve, "function");
    rolloverResolve(dashboard("today", 25, "2026-08-30"));
    const rolloverStatuses = await Promise.all(rolloverResponses);
    assert.deepEqual(
      await Promise.all(rolloverStatuses.map((response) => response.json().then((body) => body.today.tokens))),
      [25, 25],
    );

    const sameDay = await fetch(`${app.url}/api/status`);
    assert.equal((await sameDay.json()).today.tokens, 25);
    assert.equal(getCalls, 2);
  } finally {
    await app.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
});
