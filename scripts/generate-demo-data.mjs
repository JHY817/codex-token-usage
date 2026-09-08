import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = process.argv[2];
if (!outputRoot) {
  throw new Error("Usage: node scripts/generate-demo-data.mjs <output-directory>");
}
if (!path.basename(path.resolve(outputRoot)).startsWith("codex-token-usage-demo-")) {
  throw new Error("Demo output directory name must start with codex-token-usage-demo-");
}

const now = new Date();
const year = String(now.getFullYear());
const month = String(now.getMonth() + 1).padStart(2, "0");
const day = String(now.getDate()).padStart(2, "0");
const dateKey = `${year}-${month}-${day}`;
const sessionsRoot = path.join(outputRoot, "sessions", year, month, day);

const tasks = [
  ["11111111-1111-4111-8111-111111111111", "优化本地用量看板", "usage-dashboard", "gpt-6-astra", "high", 8, 45_800_000, 36_600_000],
  ["22222222-2222-4222-8222-222222222222", "排查缓存命中率", "usage-dashboard", "gpt-5.6-luna", "max", 10, 31_400_000, 25_100_000],
  ["33333333-3333-4333-8333-333333333333", "验证一键安装流程", "installer-lab", "gpt-5.6-sol", "high", 12, 18_900_000, 14_200_000],
  ["44444444-4444-4444-8444-444444444444", "完善公开仓库文档", "release-kit", "gpt-6-astra", "low", 14, 11_600_000, 8_100_000],
  ["55555555-5555-4555-8555-555555555555", "补充跨架构测试", "installer-lab", "gpt-5.6-sol", "xhigh", 16, 7_200_000, 5_900_000],
];

function event(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(sessionsRoot, { recursive: true });

const index = [];
for (const [id, title, project, model, effort, hour, total, cached] of tasks) {
  const timestamp = (minute) => `${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+08:00`;
  const input = Math.round(total * 0.9);
  const rows = [
    event(timestamp(0), "session_meta", { id, cwd: `/demo/projects/${project}`, source: "desktop" }),
    event(timestamp(1), "turn_context", { model, effort }),
    event(timestamp(2), "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: Math.min(cached, input),
          output_tokens: total - input,
          total_tokens: total,
        },
      },
    }),
  ];
  await writeFile(
    path.join(sessionsRoot, `rollout-${dateKey}T${String(hour).padStart(2, "0")}-00-00-${id}.jsonl`),
    `${rows.join("\n")}\n`,
    "utf8",
  );
  index.push(JSON.stringify({ id, thread_name: title }));
}

await writeFile(path.join(outputRoot, "session_index.jsonl"), `${index.join("\n")}\n`, "utf8");
process.stdout.write(`${outputRoot}\n`);
