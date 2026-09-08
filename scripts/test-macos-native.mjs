import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "macos", "CodexUsageMenuBar", "main.swift");
const buildPath = path.join(projectRoot, "scripts", "build-macos-app.mjs");
const installPath = path.join(projectRoot, "scripts", "install-macos-app.mjs");
const releaseInstallPath = path.join(projectRoot, "scripts", "install-release.sh");
const assetPath = path.join(projectRoot, "macos", "CodexUsageMenuBar", "Resources", "codex-template.png");
const appIconPath = path.join(projectRoot, "macos", "CodexUsageMenuBar", "Resources", "AppIcon-1024-v2.png");
const noticePath = path.join(projectRoot, "macos", "THIRD_PARTY_NOTICES.md");

const [source, build, install, releaseInstall, asset, appIcon, notice] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(buildPath, "utf8"),
  readFile(installPath, "utf8"),
  readFile(releaseInstallPath, "utf8"),
  readFile(assetPath),
  readFile(appIconPath),
  readFile(noticePath, "utf8"),
]);

assert.match(source, /enum CodexIconCatalog/);
assert.match(source, /ChatGPT\.app/);
assert.match(source, /icon-codex-dark-color\.png/);
assert.match(source, /icon-codex-light\.png/);
assert.ok(
  source.indexOf('"icon-codex-light.png"') < source.indexOf('"icon-codex-dark-color.png"'),
  "summary icon should prefer the light Codex asset before the dark fallback",
);
assert.match(source, /CodexIconView\(model: model, size: 15, template: true\)/);
assert.match(source, /var remainingPercent: Double\?/);
assert.match(source, /selectedWindow\.remainingPercent \?\? \(100 - selectedWindow\.usedPercent\)/);
assert.match(source, /return min\(100, max\(0, raw\)\)/);
assert.match(source, /func refreshIfStale\(maxAge: TimeInterval = 60, now: Date = Date\(\)\)/);
assert.match(source, /now\.timeIntervalSince\(generatedAt\) >= maxAge/);
const staleRefreshStart = source.indexOf("func refreshIfStale");
const staleRefreshEnd = source.indexOf("\n    func refresh(", staleRefreshStart);
assert.ok(staleRefreshStart >= 0 && staleRefreshEnd > staleRefreshStart, "stale refresh helper should be present");
const staleRefresh = source.slice(staleRefreshStart, staleRefreshEnd);
assert.match(staleRefresh, /guard let generatedAt else/);
assert.match(staleRefresh, /refresh\(force: true\)/);
assert.match(staleRefresh, /else \{\s*refresh\(\)\s*\}/);
const statusLabel = source.slice(source.indexOf("struct StatusBarLabel"), source.indexOf("struct QuotaProgress"));
assert.doesNotMatch(statusLabel, /UsageBar\(/, "menu bar keeps only icon and percentage");
assert.match(build, /"credits\.mjs"/, "native bundle must include the credits adapter imported by its server");
assert.match(source, /Text\(model\.remainingPercent\.map \{ "\\\(Int\(\$0\.rounded\(\)\)\)%" \} \?\? "--"\)/);
assert.match(source, /let models: \[ModelUsage\]\?/);
assert.match(source, /self\.models = payload\.models \?\? \[\]/);
assert.match(source, /environment\["PATH"\] = Self\.runtimePath\(/);
assert.match(source, /Codex launcher is a `#!\/usr\/bin\/env node` script/);
assert.match(source, /private static func runtimePath\(current: String\?, nodePath: String, codexPath: String\?\)/);
assert.match(source, /struct ModelUsageChart/);
assert.match(source, /今日模型消耗/);
assert.match(source, /模型 · 思考档位 \/ 万 Token/);
assert.match(source, /暂无模型消耗数据/);
assert.match(source, /struct PopoverActionButtonStyle/);
assert.match(source, /let isHovered: Bool/);
assert.match(source, /let primary: Bool/);
assert.match(source, /configuration\.isPressed/);
assert.match(source, /@State private var isRefreshHovered = false/);
assert.match(source, /@State private var isDetailHovered = false/);
assert.match(source, /\.buttonStyle\(PopoverActionButtonStyle\(isHovered: isRefreshHovered, primary: false\)\)/);
assert.match(source, /\.buttonStyle\(PopoverActionButtonStyle\(isHovered: isDetailHovered, primary: true\)\)/);
assert.match(source, /\.onHover \{ isRefreshHovered = \$0 \}/);
assert.match(source, /\.onHover \{ isDetailHovered = \$0 \}/);
assert.doesNotMatch(source, /Image\(systemName: "arrow\.up\.right"\)/);
assert.doesNotMatch(source, /其他额度窗口/);
assert.doesNotMatch(source, /数据状态/);
assert.doesNotMatch(source, /额度已使用/);
assert.match(source, /enum DashboardWindowPresenter/);
assert.match(source, /makeKeyAndOrderFront/);
assert.match(source, /orderFrontRegardless/);
assert.match(source, /orderOut\(nil\)/);
assert.match(source, /deminiaturize/);
assert.match(source, /DashboardWindowPresenter\.openAndFocus/);
assert.match(source, /DashboardWindowPresenter\.openFromPopover/);
assert.match(source, /dismissPopover/);
assert.match(source, /CommandLine\.arguments\.contains\("--qa-open-dashboard"\)/);
assert.match(source, /CODEX_USAGE_QA_OPEN_DASHBOARD/);
assert.match(source, /attempts: Int = 40/);
assert.match(source, /model\.refresh\(force: true\)/);
assert.match(source, /scheduledTimer\(withTimeInterval: 300, repeats: true\)/);
assert.match(source, /scheduledTimer[\s\S]*self\?\.refresh\(force: true\)/);
assert.match(source, /\/Applications\/ChatGPT\.app\/Contents\/Resources\/codex/);
assert.match(source, /\/Applications\/Codex\.app\/Contents\/Resources\/codex/);
assert.match(source, /--install-ready-file/);
assert.match(source, /CODEX_USAGE_INSTALL_READY_FILE/);
assert.match(source, /private var quotaRetryTimer: Timer\?/);
assert.match(source, /quotaRetryDelays: \[TimeInterval\] = \[5, 10, 20, 30, 60\]/);
assert.match(source, /if self\.quota\?\.available != true, let unavailable = payload\.quota/);
assert.match(source, /NSWorkspace\.didWakeNotification/);
assert.match(source, /NSApplication\.didBecomeActiveNotification/);
assert.match(source, /\.onAppear \{\s*model\.refreshIfStale\(\)\s*\}/);
assert.match(source, /private let nativeWindowBackground/);
assert.match(source, /\.background\(nativeWindowBackground/);
assert.doesNotMatch(source, /NSVisualEffectView/);
assert.doesNotMatch(source, /\.regularMaterial/);
assert.match(source, /view\.setValue\(true, forKey: "drawsBackground"\)/);
assert.match(source, /underPageBackgroundColor = \.windowBackgroundColor/);
assert.match(source, /window\.isOpaque = true/);
assert.match(source, /window\.backgroundColor = \.windowBackgroundColor/);
assert.match(source, /view\.layer\?\.backgroundColor = NSColor\.windowBackgroundColor\.cgColor/);
assert.match(source, /backdrop-filter: none/);
assert.match(source, /window\.isMovableByWindowBackground = true/);
assert.doesNotMatch(source, /,\s*\)/, "Swift 5 source must not use trailing commas before closing parentheses");
assert.match(source, /final class NativeWindowDragView: NSView/);
assert.match(source, /window\?\.performDrag\(with: event\)/);
assert.match(source, /struct NativeWindowDragRegion: NSViewRepresentable/);
assert.match(source, /NativeWindowDragRegion\(\)\s*\n\s*\.frame\(width: 320, height: 60\)/);
assert.match(source, /\.offset\(x: 84, y: 0\)/);
assert.match(source, /ZStack\(alignment: \.topLeading\)/);
assert.match(build, /codex-template\.png/);
assert.match(build, /AppIcon-1024-v2\.png/);
assert.match(build, /AppIcon\.icns/);
assert.match(build, /CFBundleIconFile/);
assert.match(build, /<string>AppIcon\.icns<\/string>/);
assert.match(build, /const appVersion = packageJson\.version/);
assert.equal((build.match(/<string>\$\{appVersion\}<\/string>/g) ?? []).length, 2);
assert.match(source, /Bundle\.main\.resourceURL\?\.appendingPathComponent\("runtime\/node"\)/);
assert.match(build, /CODEX_BUNDLED_NODE/);
assert.match(build, /CODEX_BUNDLED_NODE_LICENSE/);
assert.match(build, /NODE_LICENSE/);
assert.match(install, /async function stopRunningApp\(\)/);
assert.match(install, /execFileAsync\("pkill", \["-TERM", "-x", "CodexUsageMenuBar"\]\)/);
assert.match(install, /await stopRunningApp\(\)/);
assert.match(install, /rm\(destination, \{ recursive: true, force: true \}\)/);
assert.match(install, /lsregister/);
assert.match(install, /\["-f", destination\]/);
assert.match(releaseInstall, /CODEX_USAGE_RELEASE_BASE_URL/);
assert.match(releaseInstall, /CODEX_USAGE_DESTINATION_DIR/);
assert.match(releaseInstall, /--install-ready-file/);
assert.match(releaseInstall, /api\/status\?refresh=1/);
assert.match(releaseInstall, /rollback_install/);
assert.match(releaseInstall, /destination_app_pids/);
assert.match(releaseInstall, /server_process_pids/);
assert.match(releaseInstall, /discover_server_url/);
assert.match(releaseInstall, /lsof -Pan/);
assert.match(releaseInstall, /open -n "\$DESTINATION_APP"/);
assert.match(build, /THIRD_PARTY_NOTICES\.md/);
assert.match(notice, /MIT License/);
assert.match(notice, /Copyright \(c\) 2026 Guomeiqing/);

const assetHash = createHash("sha256").update(asset).digest("hex");
assert.equal(assetHash, "356f1c497c1accc7f9f442cc9f0c1aaf73aec3b7a677ca6d127932929658eef3");
assert.ok(appIcon.length > 100_000, "selected high-resolution App icon should be bundled as a source asset");
const appIconHash = createHash("sha256").update(appIcon).digest("hex");
assert.equal(appIconHash, "34e9b40681b1f598c1c1ccc692d97fc954d04dc1ae2bb90fcba9095069babffa");

console.log("macOS native shell contract checks passed");
