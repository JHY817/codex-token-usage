import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const [pkg, manifest, mcp] = await Promise.all([
  readJson("package.json"),
  readJson(".codex-plugin/plugin.json"),
  readJson(".mcp.json"),
]);

assert.equal(pkg.name, "codex-token-usage");
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.interface?.displayName, "Codex Token Usage");
assert.equal(mcp.mcpServers?.["codex-token-usage"]?.command, "node");

for (const file of [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "assets/dashboard-light.png",
  "macos/CodexUsageMenuBar/Resources/AppIcon-1024-v2.png",
]) {
  await readFile(path.join(root, file));
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, "Git tag must match package version");
}

console.log(`Project validation passed: ${pkg.name} v${pkg.version}`);
