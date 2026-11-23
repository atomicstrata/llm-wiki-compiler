/**
 * @file test/fixtures/temporary-cwd.ts
 * @description A fresh temporary directory per test that the command under test sees as its working
 * directory: the lifecycle the CLI-body suites shared by copy (a `mkdtemp` root, optional preparation,
 * `process.cwd()` mocked to the root; afterwards every mock restored and the root removed).
 *
 * Hooks are registered through the storage-profile hooks, so their budgets are the profile's, as in
 * the suites before. The order is the suites' own: create, prepare, mock the working directory; then
 * restore mocks, then remove. Assertions stay in the calling test.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";

/**
 * Register, for the calling test file or suite, a fresh temporary working directory per test.
 * @param prefix - The `mkdtemp` prefix under the OS temporary directory.
 * @param prepare - Runs on each new root before `process.cwd()` is mocked to return it.
 */
export function useTemporaryCwd(prefix: string, prepare: (root: string) => Promise<void>): void {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), prefix));
    await prepare(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
}
