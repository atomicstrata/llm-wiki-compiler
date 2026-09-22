/**
 * Build all core entry points together so shared authority, locks, error classes
 * and the module-instance token resolve to one set of chunks in an installation.
 */
import { defineConfig } from "tsup";
import path from "node:path";
import { execFileSync } from "node:child_process";

export default defineConfig({
  entry: {
    index: "../../src/core-index.ts",
    "compiler-cli": "../../src/compiler-cli.ts",
    "compiler-legacy-workflows": "../../src/local-workflow-host/legacy-composition.ts",
    "compiler-sdk": "../../src/sdk/compiler-composition.ts",
    "local-workflow-host": "../../src/local-workflow-host/index.ts",
    "local-workflow-contracts": "../../src/local-workflow-host/shared-contracts.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: { compilerOptions: { rootDir: path.resolve("../../src") } },
  tsconfig: "../../tsconfig.json",
  onSuccess: async () => {
    execFileSync(process.execPath, [path.resolve("../../scripts/copy-viewer-assets.mjs"), "packages/llmwiki-core/dist"]);
  },
});
