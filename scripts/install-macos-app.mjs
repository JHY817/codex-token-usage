import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Codex Token Usage.app";
const source = path.join(projectRoot, "dist", "macos", appName);
const destination = path.join(os.homedir(), "Applications", appName);
const shouldLaunch = process.argv.includes("--launch");
const execFileAsync = promisify(execFile);
const launchServicesRegister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

async function stopRunningApp() {
  try {
    await execFileAsync("pkill", ["-TERM", "-x", "CodexUsageMenuBar"]);
  } catch (error) {
    // pkill exits with 1 when this is the first install and no old instance
    // exists. Other errors should still fail the install instead of leaving a
    // stale process that keeps serving the previous bundle.
    if (error?.code !== 1) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function run() {
  if (process.platform !== "darwin") throw new Error("macOS 原生 App 只能安装在 macOS 上");
  try {
    await readFile(path.join(source, "Contents", "Info.plist"), "utf8");
  } catch {
    throw new Error("缺少构建产物，请先运行 npm run native:build");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await stopRunningApp();
  // Replacing files inside an existing .app keeps the bundle directory's old
  // identity and can leave LaunchServices/Quick Look showing a stale default
  // icon. Install a fresh bundle and register that exact path instead.
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, force: true });
  await execFileAsync("touch", [destination]);
  await execFileAsync(launchServicesRegister, ["-f", destination]);
  console.log(`已安装到 ${destination}`);
  if (shouldLaunch) {
    const child = spawn("open", [destination], { stdio: "ignore", detached: true });
    child.unref();
    console.log("已请求启动菜单栏 App");
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
