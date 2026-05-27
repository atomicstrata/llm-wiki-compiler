import { defineConfig } from "vitest/config";

const TEST_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 60_000;

export default defineConfig({
  test: {
    globals: true,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    // Don't pick up tests from sibling worktrees living under local worktree dirs.
    // Worktrees share the parent's working directory tree, so without this
    // exclude vitest discovers and runs every feature branch's tests.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", ".worktrees/**"],
    // Build dist/ once globally so parallel test workers don't race on
    // tsup's clean+write cycle (multiple beforeAll(npx tsup) calls were
    // wiping dist/cli.js mid-test).
    globalSetup: "./test/global-setup.ts",
  },
});
