import { UsageService } from "./service.mjs";

const command = process.argv[2] ?? "refresh";
const range = process.argv[3] ?? "today";

if (command !== "refresh" || !["today", "7d", "30d", "all"].includes(range)) {
  process.stderr.write("Usage: node server/cli.mjs refresh [today|7d|30d|all]\n");
  process.exit(2);
}

const service = new UsageService();
try {
  const dashboard = await service.refreshDashboard(range);
  process.stdout.write(`${JSON.stringify({
    range: dashboard.range,
    generatedAt: dashboard.generatedAt,
    tokens: dashboard.totals.tokens,
    conversations: dashboard.totals.conversations,
  })}\n`);
} finally {
  service.close();
}
