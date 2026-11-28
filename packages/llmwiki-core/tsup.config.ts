/**
 * Build all core entry points together so shared authority, locks, error classes
 * and the module-instance token resolve to one set of chunks in an installation.
 */
import { defineConfig } from "tsup";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { coreModuleEntries } from "../../scripts/public-boundary/composition.mjs";

const SRC = path.resolve("../../src");

/**
 * Every module the CLI imports by its own path
 * (`@atomicstrata/llmwiki-core/modules/commands/ingest`), read from the import
 * statements of the CLI's own files (`src/cli/` and the `workflow` command
 * modules in `src/commands/`) so the built entries cannot drift from what it
 * uses. The CLI loads a command's module when that command runs, so starting
 * it does not load every command. The public release builder and gate use the
 * same derivation (`scripts/public-boundary/composition.mjs`), which refuses a
 * malformed name or one without a `src/<name>.ts` source.
 */
const moduleEntries = coreModuleEntries(path.resolve(SRC, ".."));

/** Entry points with a public type surface; these get declarations. */
const typedEntries = {
  index: "../../src/core-index.ts",
  "compiler-cli": "../../src/compiler-cli.ts",
  "compiler-legacy-workflows": "../../src/local-workflow-host/legacy-composition.ts",
  "compiler-sdk": "../../src/sdk/compiler-composition.ts",
  "local-workflow-host": "../../src/local-workflow-host/index.ts",
  "local-workflow-contracts": "../../src/local-workflow-host/shared-contracts.ts",
};

export default defineConfig({
  entry: { ...moduleEntries, ...typedEntries },
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  splitting: true,
  sourcemap: true,
  clean: true,
  // Only the CLI bundle imports the per-module entries, and it type-checks against src.
  dts: { entry: typedEntries, compilerOptions: { rootDir: SRC } },
  tsconfig: "../../tsconfig.json",
  onSuccess: async () => {
    execFileSync(process.execPath, [path.resolve("../../scripts/copy-viewer-assets.mjs"), "packages/llmwiki-core/dist"]);
  },
});
