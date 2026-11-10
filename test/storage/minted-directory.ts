/**
 * @file test/storage/minted-directory.ts
 * @description One assertion shared by the storage tests that MINT RECORDS ON
 * DISK ONCE, copy them into memory, and remove the directory before any case
 * runs: `preparation-record-reads-binding.test.ts` and
 * `preparation-key-read-binding.test.ts`. Each of them opens with a case that
 * shows the minting directory is gone, so that no later case can be reading it.
 * What "gone" has to mean is stated once, here.
 *
 * WHAT IT CHECKS. Two things about a path the calling test kept from its own
 * minting: that its last segment carries the prefix that test gave the shared
 * temp-root tracker, and that nothing exists at it now.
 *
 * WHAT IT IS NOT. It removes nothing and creates nothing; the tracker in
 * `test/temp-roots.ts` does both. It is not evidence that the directory ever
 * existed, that it sat inside the operating system's temporary directory, or
 * that nothing else was written elsewhere. It is not a general test framework:
 * it holds this one assertion and nothing else.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { expect } from "bun:test";

/**
 * Assert that `dir` is a directory the calling test named with its own
 * `prefix`, and that it no longer exists.
 *
 * @param dir - The path the test's one minting used, as the tracker returned it.
 * @param prefix - The prefix that test passed to the tracker.
 */
export function expectMintingDirectoryRemoved(dir: string, prefix: string): void {
  expect(path.basename(dir).startsWith(prefix)).toBe(true);
  expect(existsSync(dir)).toBe(false);
}
