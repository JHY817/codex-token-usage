import { lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const appName = "Codex Token Usage.app";
const destination = path.join(os.homedir(), "Applications", appName);

async function run() {
  if (process.platform !== "darwin") throw new Error("macOS 原生 App 只能在 macOS 上卸载");
  try {
    const info = await lstat(destination);
    if (!info.isDirectory()) throw new Error(`${destination} 不是 App 目录，已停止卸载`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log(`未找到已安装的 ${appName}`);
      return;
    }
    throw error;
  }
  await rm(destination, { recursive: true, force: false });
  console.log(`已卸载 ${destination}；本地数据快照未删除`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
