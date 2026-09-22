import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

const TEST_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 60_000;

export default defineConfig({
  // In-repository tests exercise source. Packed consumers still import the
  // installed compiler peer by name; this resolver is not shipped at runtime.
  resolve: {
    alias: [
      { find: /^@atomicstrata\/llmwiki-core\/compiler-cli$/, replacement: fileURLToPath(new URL("./src/compiler-cli.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core\/compiler-legacy-workflows$/, replacement: fileURLToPath(new URL("./src/local-workflow-host/legacy-composition.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core\/compiler-sdk$/, replacement: fileURLToPath(new URL("./src/sdk/compiler-composition.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-local-workflows$/, replacement: fileURLToPath(new URL("./src/local-workflows/index.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core\/local-workflow-host$/, replacement: fileURLToPath(new URL("./src/local-workflow-host/index.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core$/, replacement: fileURLToPath(new URL("./src/core-index.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core\/local-workflow-contracts$/, replacement: fileURLToPath(new URL("./src/local-workflow-host/shared-contracts.ts", import.meta.url)) },
      { find: /^llm-wiki-compiler$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
      ...["llmwiki-dev-backend", "llmwiki-limited-isolation-backend"].map(name => ({
        find: new RegExp("^" + name + "$"),
        replacement: fileURLToPath(new URL("./packages/" + name + "/src/index.ts", import.meta.url)),
      })),
    ],
  },
  test: {
    globals: true,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    // Many integration tests spawn a CLI subprocess. With one worker per core
    // each ALSO spawning a node process, the machine is oversubscribed ~2x and
    // subprocess spawns get starved past their timeout — a non-deterministic
    // failure whose victim varies per run. Cap workers to half the cores so
    // each worker+subprocess pair fits, independent of how many subprocess
    // tests exist.
    maxWorkers: "50%",
    minWorkers: 1,
    // Don't pick up tests from sibling worktrees living under local worktree dirs.
    // Worktrees share the parent's working directory tree, so without this
    // exclude vitest discovers and runs every feature branch's tests.
    exclude: [
      ...configDefaults.exclude,
      ".claude/**",
      ".worktrees/**",
      "test/sdk/packaging.test.ts",
    ],
    // Build dist/ once globally so parallel test workers don't race on
    // tsup's clean+write cycle (multiple beforeAll(npx tsup) calls were
    // wiping dist/cli.js mid-test).
    globalSetup: "./test/global-setup.ts",
  },
});
