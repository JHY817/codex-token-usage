import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { UsageService } from "../server/service.mjs";

const VALID_RANGES = new Set(["today", "7d", "30d", "all"]);

function localUsageApi() {
  function installUsageApi(server) {
    const service = new UsageService();
    server.httpServer?.once("close", () => service.close());
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isRead = url.pathname === "/api/usage" && request.method === "GET";
      const isRefresh = url.pathname === "/api/usage/refresh" && request.method === "POST";
      if (!isRead && !isRefresh) return next();

      const requestedRange = url.searchParams.get("range");
      const range = VALID_RANGES.has(requestedRange) ? requestedRange : "today";
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      try {
        const dashboard = isRefresh
          ? await service.refreshDashboard(range)
          : await service.getDashboard(range);
        response.statusCode = 200;
        response.end(JSON.stringify({ dashboard }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "本地数据读取失败" }));
      }
    });
  }

  return {
    name: "codex-local-usage-api",
    configureServer: installUsageApi,
    configurePreviewServer: installUsageApi,
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [localUsageApi(), react()],
});
