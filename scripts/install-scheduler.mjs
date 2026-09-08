import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.codex.token-usage-insights";
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
const dataDir = join(homedir(), ".codex", "token-usage-insights");
const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
const cliPath = join(projectRoot, "server", "cli.mjs");
const domain = `gui/${process.getuid()}`;

const xmlEscape = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>refresh</string>
    <string>today</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>23</integer>
    <key>Minute</key>
    <integer>59</integer>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(dataDir, "scheduler.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(dataDir, "scheduler-error.log"))}</string>
</dict>
</plist>
`;

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(plistPath, plist, "utf8");

try {
  execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
} catch {
  // The job may not be loaded yet.
}

execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
execFileSync("launchctl", ["enable", `${domain}/${LABEL}`], { stdio: "inherit" });

console.log(`已启用每日 23:59 快照：${plistPath}`);
