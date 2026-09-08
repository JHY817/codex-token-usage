import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/mcp", { recursive: true });

await build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2022"],
  outfile: "dist/mcp/component.js",
  jsx: "automatic",
  legalComments: "none",
  logLevel: "info",
});
