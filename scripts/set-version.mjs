import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextVersion = process.argv[2]?.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion ?? "")) {
  throw new Error("用法：npm run release:prepare -- 0.2.0");
}

for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
  const file = path.join(root, relative);
  const value = JSON.parse(await readFile(file, "utf8"));
  value.version = nextVersion;
  if (relative === "package-lock.json" && value.packages?.[""]) {
    value.packages[""].version = nextVersion;
  }
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

console.log(`Version updated to ${nextVersion}`);
