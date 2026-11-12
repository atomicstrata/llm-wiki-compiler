/**
 * Build all core entry points together so shared authority, locks, error classes
 * and the module-instance token resolve to one set of chunks in an installation.
 */
import { defineConfig } from "tsup";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const SRC = path.resolve("../../src");

/**
 * Every module the CLI imports by its own path
 * (`@atomicstrata/llmwiki-core/modules/commands/ingest`), read from the import
 * statements of the CLI's own files (`src/cli/` and the `workflow` command
 * modules in `src/commands/`) so the built entries cannot drift from what it
 * uses. The CLI loads a command's module when that command runs, so starting
 * it does not load every command.
 */
const COMMANDS_DIR = path.join(SRC, "commands");
const cliFiles = [
  ...readdirSync(path.join(SRC, "cli")).map((file) => path.join(SRC, "cli", file)),
  ...readdirSync(COMMANDS_DIR).filter((file) => /^workflow.*\.ts$/.test(file)).map((file) => path.join(COMMANDS_DIR, file)),
];
const moduleNames = new Set(cliFiles.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/"@atomicstrata\/llmwiki-core\/modules\/([^"]+)"/g)]
    .map((match) => match[1])));

const moduleEntries = Object.fromEntries(
  [...moduleNames].map((name) => [`modules/${name}`, path.join(SRC, `${name}.ts`)]),
);

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
