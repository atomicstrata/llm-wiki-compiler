/**
 * Shared helpers for `llmwiki next` tests so the same invariants can be
 * asserted at both the unit and the subprocess layer without copy-pasted
 * five-line idioms. Extracted to keep fallow happy and to make the
 * "next must not mutate the project" rule callable from one spot.
 */

import { readdir, access } from "fs/promises";
import path from "path";
import { expect } from "vitest";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";

/**
 * Assert that the given project root has zero entries and that `.llmwiki/`
 * does not exist. Use after running `next` (CLI or in-process collector)
 * in a fresh temp directory to pin the no-mutation invariant.
 */
export async function expectFreshDirUnchanged(root: string): Promise<void> {
  const entries = await readdir(root);
  expect(entries).toEqual([]);
  await expect(access(path.join(root, LLMWIKI_DIR))).rejects.toThrow();
}
