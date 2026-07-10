/**
 * @file test/trust/fixture.ts
 * @description Shared tmp-dir fixture for the Trust Guard write-path tests
 * (journal + planner/executor). Both suites stand up an isolated project root
 * with a `wiki/concepts` directory, then probe/clean it the same way; this
 * module is the single definition of that fixture so the setup is not duplicated
 * across test files.
 */

import { mkdtemp, rm, mkdir, access, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { expect } from "vitest";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import type { WriteOne } from "../../src/trust/executor.js";

/**
 * A fault-injecting {@link WriteOne} that throws on the `nth` (1-based) call and
 * performs a real write on every other call — the shared seam both the executor
 * and compile-adapter atomicity tests use to force a mid-batch failure without
 * each duplicating the throw-on-Nth closure.
 *
 * @param nth - The 1-based call index on which to throw `injected write failure`.
 */
export function failingWriteOneOnNth(nth: number): WriteOne {
  let calls = 0;
  return async (filePath: string, content: string) => {
    calls += 1;
    if (calls === nth) throw new Error("injected write failure");
    await writeFile(filePath, content, "utf-8");
  };
}

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
  return exists(path.join(root, rel));
}

/** True when the absolute path `p` exists on disk. */
export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A project root paired with an out-of-tree scratch dir, for symlink-escape tests. */
export interface RootWithOutside {
  /** The isolated project root (has `wiki/concepts/`). */
  root: string;
  /** An out-of-tree directory used as the symlink-escape target / victim home. */
  outsideDir: string;
}

/**
 * Stand up a project {@link makeTrustRoot} alongside a sibling out-of-tree dir,
 * the shared `beforeEach` shape for the `.llmwiki` symlink-escape suites. Pair
 * with {@link cleanupRootWithOutside} in `afterEach`.
 *
 * @param prefix - tmp-dir name prefix (the outside dir reuses it with `-outside`).
 */
export async function makeRootWithOutside(prefix: string): Promise<RootWithOutside> {
  return {
    root: await makeTrustRoot(prefix),
    outsideDir: await mkdtemp(path.join(tmpdir(), `${prefix}outside-`)),
  };
}

/** Tear down a {@link makeRootWithOutside} pair (best-effort). */
export async function cleanupRootWithOutside(fixture: RootWithOutside): Promise<void> {
  await cleanupTrustRoot(fixture.root);
  if (fixture.outsideDir) await rm(fixture.outsideDir, { recursive: true, force: true });
}

/**
 * Assert one full acquire→release cycle on `root`: the lock is acquired, the lock
 * file then exists under `.llmwiki`, release removes it, and the file is absent
 * afterward. The shared "acquire actually creates / release actually removes the
 * lock" contract both the acquire-confine and release-confine suites assert.
 *
 * @param root - The project root to exercise the lock on.
 */
export async function expectLockAcquireRelease(root: string): Promise<void> {
  expect(await acquireLock(root)).toBe(true);
  expect(await existsUnder(root, `${LLMWIKI_DIR}/lock`)).toBe(true);
  await releaseLock(root);
  expect(await existsUnder(root, `${LLMWIKI_DIR}/lock`)).toBe(false);
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
