import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readQuota } from "./quota.mjs";
import { UsageService } from "./service.mjs";
import { readCreditsSummary } from "./credits.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_RANGES = new Set(["today", "7d", "30d", "all"]);
const DEFAULT_PORT = 4173;
const DEFAULT_QUOTA_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_QUOTA_UNAVAILABLE_TTL_MS = 5 * 1_000;

function jsonHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // The server binds to loopback only. This header is useful for a WKWebView
    // loaded from the same local origin and does not expose data to the LAN.
    "access-control-allow-origin": "http://127.0.0.1",
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, jsonHeaders());
  response.end(JSON.stringify(payload));
}

function errorMessage(error, fallback = "本地数据读取失败") {
  return error instanceof Error ? error.message : String(error || fallback);
}

function durationOption(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : fallback;
}

function unavailableQuota(error = "额度暂不可用") {
  return {
    available: false,
    source: "codex-app-server",
    selected: null,
    windows: [],
    error,
  };
}

function normalizeQuota(value) {
  if (!value || typeof value !== "object") return unavailableQuota("额度读取返回为空");
  return {
    ...value,
    available: value.available === true,
    source: value.source ?? "codex-app-server",
    selected: value.selected ?? null,
    windows: Array.isArray(value.windows) ? value.windows : [],
    error: value.error ?? null,
  };
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function statusModels(dashboard) {
  if (!dashboard || !Array.isArray(dashboard.models)) return [];
  return dashboard.models.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const id = typeof model.id === "string" && model.id.trim() ? model.id : null;
    const label = typeof model.label === "string" && model.label.trim()
      ? model.label
      : typeof model.displayLabel === "string" && model.displayLabel.trim()
        ? model.displayLabel
        : null;
    const tokens = Number(model.tokens);
    const share = Number(model.share);
    if (!id || !label || !Number.isFinite(tokens) || tokens < 0) return [];
    return [{
      id,
      label,
      tokens,
      share: Number.isFinite(share) && share >= 0 ? share : 0,
      breakdown: model.breakdown ?? null,
    }];
  });
}

function parseParentPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return error?.code === "EPERM";
  }
}

/**
 * Stop a native-app-owned host when the app is killed without running its
 * normal termination handler. A standalone `desktop:start` has no parent PID
 * environment variable, so it deliberately does not enable this watchdog.
 * Dependencies are injectable to keep lifecycle tests from touching or
 * terminating the test runner.
 */
export function createParentProcessWatchdog({
  parentPid = process.env.CODEX_USAGE_PARENT_PID,
  intervalMs = Number(process.env.CODEX_USAGE_PARENT_CHECK_INTERVAL_MS) || 2_000,
  getParentPid = () => process.ppid,
  processAlive = isProcessAlive,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onOrphan = () => {},
} = {}) {
  const expectedParentPid = parseParentPid(parentPid);
  if (!expectedParentPid) {
    return {
      enabled: false,
      expectedParentPid: null,
      check: async () => false,
      stop: () => {},
    };
  }

  let stopped = false;
  let orphanHandled = false;
  let timer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  };

  const check = async () => {
    if (stopped || orphanHandled) return false;
    let actualParentPid;
    try {
      actualParentPid = Number(getParentPid());
    } catch {
      actualParentPid = 1;
    }
    let parentAlive = false;
    try {
      parentAlive = processAlive(expectedParentPid);
    } catch {
      parentAlive = false;
    }
    const orphaned = actualParentPid <= 1
      || actualParentPid !== expectedParentPid
      || !parentAlive;
    if (!orphaned) return false;

    orphanHandled = true;
    stop();
    await onOrphan({ expectedParentPid, actualParentPid });
    return true;
  };

  timer = setIntervalFn(() => {
    void check();
  }, Math.max(250, Number(intervalMs) || 2_000));
  timer?.unref?.();

  return {
    enabled: true,
    expectedParentPid,
    check,
    stop,
  };
}

function requestedRange(url) {
  const range = url.searchParams.get("range") ?? "today";
  return VALID_RANGES.has(range) ? range : null;
}

function requestedConversationIds(url) {
  const values = url.searchParams.getAll("conversationIds");
  if (values.length > 1) return values;
  const raw = values[0];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    const error = new TypeError("conversationIds 必须是 JSON 数组");
    error.statusCode = 400;
    throw error;
  }
}

function safeStaticPath(staticRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = path.resolve(staticRoot);
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
  }[extension] ?? "application/octet-stream";
}

async function serveStatic(staticRoot, requestPath, response) {
  let filePath = safeStaticPath(staticRoot, requestPath);
  if (!filePath) {
    sendJson(response, 400, { error: "非法文件路径" });
    return;
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    // Keep the dashboard a client-side SPA: an unknown non-API path loads the
    // built index, while missing assets remain 404s.
    if (!path.extname(filePath)) {
      filePath = safeStaticPath(staticRoot, "/") ?? filePath;
      try {
        fileInfo = await stat(filePath);
      } catch {
        fileInfo = null;
      }
    }
  }
  if (!fileInfo?.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": path.basename(filePath) === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end("读取文件失败");
  }).pipe(response);
}

function dashboardStatus(dashboard, { quota, error = null } = {}) {
  return {
    todayCredits: null,
    creditsAvailable: false,
    creditsError: "官方账号接口未提供 credits 消耗",
    // Keep an unavailable quota object in the response. The client can then
    // surface the actual reader error and schedule a retry instead of
    // confusing a transient failure with an absent quota source.
    quota: quota ?? unavailableQuota(),
    today: dashboard?.totals ?? null,
    todayTotals: dashboard?.totals ?? null,
    models: statusModels(dashboard),
    generatedAt: dashboard?.generatedAt ?? null,
    dataSource: dashboard?.dataSource ?? "unavailable",
    error: error ?? dashboard?.error ?? quota?.error ?? null,
  };
}

/**
 * Create the loopback-only HTTP host used by the Swift menu-bar app and by
 * local development. The dependencies are injectable so endpoint behavior
 * can be tested without touching the user's Codex state or account.
 */
export function createUsageHttpServer({
  service = new UsageService(),
  quotaReader = readQuota,
  creditsReader = readCreditsSummary,
  staticRoot = process.env.CODEX_USAGE_UI_ROOT ?? path.join(ROOT, "ui", "dist", "client"),
  quotaTtlMs = durationOption(process.env.CODEX_USAGE_QUOTA_TTL_MS, DEFAULT_QUOTA_TTL_MS),
  quotaUnavailableTtlMs = durationOption(
    process.env.CODEX_USAGE_QUOTA_UNAVAILABLE_TTL_MS,
    DEFAULT_QUOTA_UNAVAILABLE_TTL_MS,
  ),
  now = () => Date.now(),
} = {}) {
  let quotaCache = null;
  let quotaPromise = null;
  let statusDashboard = null;
  let statusPromise = null;
  let closed = false;

  async function getQuotaCached(force = false) {
    const cacheTtlMs = quotaCache?.value?.available === true
      ? quotaTtlMs
      : quotaUnavailableTtlMs;
    const cacheFresh = quotaCache && now() - quotaCache.fetchedAtMs < cacheTtlMs;
    if (!force && cacheFresh) return quotaCache.value;
    if (quotaPromise) return quotaPromise;
    quotaPromise = Promise.resolve().then(() => quotaReader()).then((value) => {
      const normalized = normalizeQuota(value);
      quotaCache = { fetchedAtMs: now(), value: normalized };
      return normalized;
    }).catch((error) => {
      const value = unavailableQuota(errorMessage(error, "额度读取失败"));
      quotaCache = { fetchedAtMs: now(), value };
      return value;
    }).finally(() => {
      quotaPromise = null;
    });
    return quotaPromise;
  }

  async function getTodayDashboard(force = false) {
    // Usage follows the user's chosen cadence: once a same-day snapshot is
    // available, ordinary status polling must not rescan the rollout logs.
    // A snapshot from a previous local day is never a valid "today" result.
    // Only an explicit refresh, the first request, or a day rollover is
    // allowed to call the collector through UsageService.
    const currentDay = localDayKey(now());
    const sameLocalDay = currentDay !== null && statusDashboard?.periodEnd === currentDay;
    if (!force && sameLocalDay) return statusDashboard;
    if (statusPromise) return statusPromise;
    statusPromise = (force ? service.refreshDashboard("today") : service.getDashboard("today"))
      .then((dashboard) => {
        statusDashboard = dashboard;
        return dashboard;
      })
      .finally(() => {
        statusPromise = null;
      });
    return statusPromise;
  }

  async function handleApi(request, response, url) {
    if (url.pathname === "/api/official-usage" && request.method === "GET") {
      const range = requestedRange(url);
      if (!range) { sendJson(response, 400, { error: "range 必须是 today、7d、30d 或 all" }); return; }
      const force = url.searchParams.get("refresh") === "1";
      const [creditsResult, quotaResult] = await Promise.allSettled([
        Promise.resolve().then(() => creditsReader(range, { force })), getQuotaCached(force),
      ]);
      const officialUsage = creditsResult.status === "fulfilled" && creditsResult.value
        ? creditsResult.value : { ...await readCreditsSummary(range), error: "credits 读取失败" };
      sendJson(response, 200, { officialUsage, quota: quotaResult.status === "fulfilled" ? quotaResult.value : unavailableQuota() });
      return;
    }
    if (url.pathname === "/api/conversation-usage-totals" && request.method === "GET") {
      try {
        const totals = await service.getConversationUsageTotals(
          requestedConversationIds(url),
          new Date(now()),
          { includeBreakdowns: true },
        );
        sendJson(response, 200, totals?.totals ? totals : { totals, cumulativeBreakdowns: {} });
      } catch (error) {
        const statusCode = [400, 404].includes(Number(error?.statusCode)) ? Number(error.statusCode) : 500;
        sendJson(response, statusCode, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/conversation-usage" && request.method === "GET") {
      try {
        const detail = await service.getConversationUsageDetail(
          url.searchParams.get("conversationId"),
          new Date(now()),
          { force: url.searchParams.get("refresh") === "1" },
        );
        if (!detail) {
          sendJson(response, 404, { error: "未找到对应的本地任务" });
          return;
        }
        sendJson(response, 200, { detail });
      } catch (error) {
        const statusCode = [400, 404].includes(Number(error?.statusCode)) ? Number(error.statusCode) : 500;
        sendJson(response, statusCode, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/usage" && request.method === "GET") {
      const range = requestedRange(url);
      if (!range) {
        sendJson(response, 400, { error: "range 必须是 today、7d、30d 或 all" });
        return;
      }
      try {
        const dashboard = await service.getDashboard(range);
        if (range === "today") {
          statusDashboard = dashboard;
        }
        sendJson(response, 200, { dashboard });
      } catch (error) {
        sendJson(response, 500, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/usage/refresh" && request.method === "POST") {
      const range = requestedRange(url);
      if (!range) {
        sendJson(response, 400, { error: "range 必须是 today、7d、30d 或 all" });
        return;
      }
      try {
        const dashboard = await service.refreshDashboard(range);
        if (range === "today") {
          statusDashboard = dashboard;
        }
        sendJson(response, 200, { dashboard });
      } catch (error) {
        sendJson(response, 500, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const force = url.searchParams.get("refresh") === "1";
      const [dashboardResult, quotaResult] = await Promise.allSettled([
        getTodayDashboard(force),
        getQuotaCached(force),
      ]);
      const dashboard = dashboardResult.status === "fulfilled" ? dashboardResult.value : null;
      const quota = quotaResult.status === "fulfilled" ? quotaResult.value : null;
      const errors = [
        dashboardResult.status === "rejected" ? errorMessage(dashboardResult.reason) : null,
        quota?.available === false ? quota.error : null,
      ].filter(Boolean);
      sendJson(response, 200, dashboardStatus(dashboard, {
        quota,
        error: errors.length ? errors.join("；") : null,
      }));
      return;
    }

    sendJson(response, 404, { error: "接口不存在" });
  }

  const server = createServer(async (request, response) => {
    const host = request.headers.host?.split(":")[0];
    // The listener is loopback-only, but reject a forwarded/non-local Host to
    // keep accidental proxying from turning this into a remote data endpoint.
    if (host && host !== "127.0.0.1" && host !== "localhost") {
      sendJson(response, 403, { error: "仅允许本机访问" });
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, { error: "非法请求地址" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end("Method Not Allowed");
      return;
    }
    await serveStatic(staticRoot, url.pathname, response);
  });

  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await new Promise((resolve) => server.close(() => resolve()));
      } catch {
        // Closing an already-closed server is safe for callers during app exit.
      }
      if (service && typeof service.close === "function") service.close();
    },
  };
}

export async function startUsageHttpServer(options = {}) {
  const host = "127.0.0.1";
  const port = Number(options.port ?? process.env.CODEX_USAGE_PORT ?? DEFAULT_PORT);
  const app = createUsageHttpServer(options);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      app.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      app.server.off("error", onError);
      resolve();
    };
    app.server.once("error", onError);
    app.server.once("listening", onListening);
    app.server.listen({ host, port });
  });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    ...app,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
  };
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const app = await startUsageHttpServer();
  process.stdout.write(`CODEX_USAGE_SERVER_READY ${JSON.stringify({ url: app.url, port: app.port })}\n`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    watchdog.stop();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  const watchdog = createParentProcessWatchdog({ onOrphan: shutdown });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
