/**
 * @file test/trust/fixture.ts
 * @description Shared tmp-dir fixture for the Trust Guard write-path tests
 * (journal + planner/executor). Both suites stand up an isolated project root
 * with a `wiki/concepts` directory, then probe/clean it the same way; this
 * module is the single definition of that fixture so the setup is not duplicated
 * across test files.
 */

import { mkdtemp, rm, mkdir, access, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { expect } from "vitest";

/** The wiki subdirectory page targets live under in these tests. */
export const WIKI = "wiki/concepts";

/** Create an isolated project root with `wiki/concepts/` ready. */
export async function makeTrustRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, WIKI), { recursive: true });
  return root;
}

/** Recursively remove a fixture root (best-effort). */
export async function cleanupTrustRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** True when `rel` exists under `root`. */
export async function existsUnder(root: string, rel: string): Promise<boolean> {
  try {
    await access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert the two-target FULL pre-state contract shared by the journal-replay and
 * executor-atomicity tests: the pre-existing target was reverted to its prior
 * bytes and the absent-pre-batch target stays absent — never a partial
 * post-state. `restored` is the bytes the pre-existing file must hold again.
 */
export async function expectRevertedToPreState(
  root: string,
  priorRel: string,
  restored: string,
  absentRel: string,
): Promise<void> {
  expect(await readFile(path.join(root, priorRel), "utf-8")).toBe(restored);
  expect(await existsUnder(root, absentRel)).toBe(false);
}
