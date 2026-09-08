import { cp, lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const arch = process.env.CODEX_BUILD_ARCH ?? process.arch;
const normalizedArch = arch === "x64" || arch === "x86_64" ? "x64" : "arm64";
const appName = "Codex Token Usage.app";
const app = path.join(root, "dist", "macos", appName);
const output = path.join(root, "dist", "release");
const staging = path.join(root, "dist", `release-staging-${normalizedArch}`);
const base = `Codex-Token-Usage-macOS-${normalizedArch}`;
const zipPath = path.join(output, `${base}.zip`);
const dmgPath = path.join(output, `${base}.dmg`);

const info = await lstat(app).catch(() => null);
if (!info?.isDirectory()) throw new Error("缺少 macOS App，请先运行 npm run native:build");

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(output, { recursive: true });
await rm(zipPath, { force: true });
await rm(dmgPath, { force: true });
await cp(app, path.join(staging, appName), { recursive: true });
await symlink("/Applications", path.join(staging, "Applications"));

await execFileAsync("ditto", ["-c", "-k", "--keepParent", app, zipPath]);
await execFileAsync("hdiutil", [
  "create", "-volname", `Codex Token Usage ${pkg.version}`,
  "-srcfolder", staging, "-ov", "-format", "UDZO", dmgPath,
]);
await rm(staging, { recursive: true, force: true });

console.log(zipPath);
console.log(dmgPath);
