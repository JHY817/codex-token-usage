import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.codex.token-usage-insights";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;

if (existsSync(plistPath)) {
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "inherit" });
  } catch {
    // Continue so a stale configuration can still be removed.
  }
  unlinkSync(plistPath);
}

console.log("已停用每日 23:59 快照；历史快照仍保留在 ~/.codex/token-usage-insights。 ");
