import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "macos", "CodexUsageMenuBar");
const appName = "Codex Token Usage.app";
const appRoot = path.join(projectRoot, "dist", "macos", appName);
const contentsRoot = path.join(appRoot, "Contents");
const resourcesRoot = path.join(contentsRoot, "Resources");
const binaryPath = path.join(contentsRoot, "MacOS", "CodexUsageMenuBar");
const appIconSource = path.join(sourceRoot, "Resources", "AppIcon-1024-v2.png");
const appIconSetRoot = path.join(projectRoot, "dist", "macos", "CodexUsageMenuBar.iconset");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const appVersion = packageJson.version;
const buildArch = process.env.CODEX_BUILD_ARCH ?? process.arch;
const swiftArch = buildArch === "x64" ? "x86_64" : buildArch;
const bundledNodePath = process.env.CODEX_BUNDLED_NODE?.trim();
const bundledNodeLicensePath = process.env.CODEX_BUNDLED_NODE_LICENSE?.trim();

async function buildAppIcon() {
  const iconSizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  await rm(appIconSetRoot, { recursive: true, force: true });
  await mkdir(appIconSetRoot, { recursive: true });
  for (const [fileName, size] of iconSizes) {
    await execFileAsync("sips", [
      "-z", String(size), String(size),
      appIconSource,
      "--out", path.join(appIconSetRoot, fileName),
    ]);
  }
  await execFileAsync("iconutil", [
    "-c", "icns",
    appIconSetRoot,
    "-o", path.join(resourcesRoot, "AppIcon.icns"),
  ]);
  await rm(appIconSetRoot, { recursive: true, force: true });
}

async function ensureBuiltClient() {
  const indexPath = path.join(projectRoot, "ui", "dist", "client", "index.html");
  try {
    await readFile(indexPath, "utf8");
  } catch {
    throw new Error("缺少 ui/dist/client/index.html，请先运行 npm run build");
  }
}

async function run() {
  if (process.platform !== "darwin") {
    throw new Error("macOS 原生菜单栏 App 只能在 macOS 上构建");
  }
  await ensureBuiltClient();
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await mkdir(resourcesRoot, { recursive: true });

  await execFileAsync("swiftc", [
    "-parse-as-library",
    "-swift-version", "5",
    "-O",
    "-target", `${swiftArch}-apple-macosx13.0`,
    "-framework", "SwiftUI",
    "-framework", "AppKit",
    "-framework", "WebKit",
    "-o", binaryPath,
    path.join(sourceRoot, "main.swift"),
  ], { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });

  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Codex Token Usage</string>
  <key>CFBundleExecutable</key>
  <string>CodexUsageMenuBar</string>
  <key>CFBundleIdentifier</key>
  <string>com.codex.token-usage-insights.menubar</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon.icns</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Codex Token Usage</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${appVersion}</string>
  <key>CFBundleVersion</key>
  <string>${appVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
  await writeFile(path.join(contentsRoot, "Info.plist"), infoPlist, "utf8");
  await buildAppIcon();

  const serverResource = path.join(resourcesRoot, "server");
  await mkdir(serverResource, { recursive: true });
  for (const file of ["http.mjs", "quota.mjs", "credits.mjs", "service.mjs", "store.mjs", "usage.mjs", "labels.mjs"]) {
    await cp(path.join(projectRoot, "server", file), path.join(serverResource, file));
  }
  await cp(path.join(projectRoot, "ui", "dist", "client"), path.join(resourcesRoot, "ui", "dist", "client"), { recursive: true });
  await cp(path.join(sourceRoot, "Resources", "codex-template.png"), path.join(resourcesRoot, "codex-template.png"));
  await cp(path.join(projectRoot, "macos", "THIRD_PARTY_NOTICES.md"), path.join(resourcesRoot, "THIRD_PARTY_NOTICES.md"));

  if (bundledNodePath) {
    const runtimeRoot = path.join(resourcesRoot, "runtime");
    const bundledNodeTarget = path.join(runtimeRoot, "node");
    await mkdir(runtimeRoot, { recursive: true });
    await cp(bundledNodePath, bundledNodeTarget, { dereference: true });
    await execFileAsync("chmod", ["755", bundledNodeTarget]);
    if (!bundledNodeLicensePath) {
      throw new Error("设置 CODEX_BUNDLED_NODE 时还必须设置 CODEX_BUNDLED_NODE_LICENSE");
    }
    await cp(bundledNodeLicensePath, path.join(runtimeRoot, "NODE_LICENSE"));
  }

  // Ad-hoc development bundle: it is intentionally not signed or notarized.
  console.log(`已构建 ${appRoot}`);
  console.log(bundledNodePath ? "已包含 Node.js 运行时。" : "未包含 Node.js；本地开发包会使用系统 Node.js 22+。");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
