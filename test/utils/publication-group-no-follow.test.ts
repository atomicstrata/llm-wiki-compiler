/**
 * @file test/utils/publication-group-no-follow.test.ts
 * @description The publication group's held read opens the leaf it observed
 * WITHOUT following a symlink (shared no-follow open, coordinator finding on
 * `publication-group.ts` `readHeld`).
 *
 * `openFileNoFollow` adds only `O_NONBLOCK` on hosts with `O_NOFOLLOW`, so
 * the caller's flags must include `O_NOFOLLOW`. Without it, a leaf swapped for
 * a symlink between the observation's `lstat` and the open is FOLLOWED: the
 * kernel opens the link's target, and only the later full-width `fstat`
 * comparison refuses it.
 *
 * WITNESS (observed behaviour, not a mirrored flags assertion). A labelled
 * call-through seam on `openFileNoFollow` performs that swap at the exact
 * window (F renamed aside to a 0600 single-link file, F replaced by a
 * symlink to it), then calls the REAL helper with the caller's own flags and
 * records what the real kernel open did. The fix is witnessed by the real open
 * REJECTING with `ELOOP` instead of returning a handle on the target. Either
 * way the observation refuses, and the target's bytes stay unchanged.
 *
 * Applies only where `constants.O_NOFOLLOW` exists; on a host without it the
 * portable path is unchanged and this case is skipped.
 */

import { constants } from "node:fs";
import { chmod, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as noFollow from "../../src/utils/no-follow-open.js";
import { observePublicationGroup } from "../../src/utils/publication-group.js";
import { privateRoots } from "../fixtures/scoped-test-roots.js";

const BODY = "{\"fixture\":true}\n";
const MAX_BYTES = 1024;
const { privateDir, cleanup } = privateRoots("llmwiki-pub-no-follow-");
afterAll(cleanup);

/** A private root with one settled 0600 single-link F at `<root>/pub/leaf.json`. */
async function settledFinal(): Promise<{ root: string; final: string }> {
  const root = await privateDir();
  await mkdir(path.join(root, "pub"), { mode: 0o700 });
  const final = path.join(root, "pub", "leaf.json");
  await writeFile(final, BODY);
  await chmod(final, 0o600);
  return { root, final };
}

/** What the real open did under the swap seam: a handle on the target ("followed") or the rejection code. */
async function observeWithSwap(root: string, final: string): Promise<{ realOpen: string; reason: string; target: string }> {
  const real = noFollow.openFileNoFollow;
  const target = path.join(root, "pub", "moved-aside");
  let realOpen = "not reached";
  const seam = spyOn(noFollow, "openFileNoFollow").mockImplementation(async (file, flags, mode) => {
    await rename(file, target);
    await symlink(target, file);
    try {
      const handle = await real(file, flags, mode);
      realOpen = "followed";
      return handle;
    } catch (error) {
      realOpen = (error as NodeJS.ErrnoException).code ?? String(error);
      throw error;
    }
  });
  try {
    const observation = await observePublicationGroup(final, root, MAX_BYTES);
    return { realOpen, reason: observation.kind === "refused" ? observation.reason : observation.kind, target: await readFile(target, "utf8") };
  } finally {
    seam.mockRestore();
  }
}

describe("the held publication read never follows a swapped-in symlink", () => {
  it.skipIf(!constants.O_NOFOLLOW)("the real open refuses the symlink (ELOOP) and the observation refuses, target unchanged", async () => {
    const { root, final } = await settledFinal();
    const seen = await observeWithSwap(root, final);
    expect(seen.realOpen).toBe("ELOOP");
    expect(seen.reason).not.toBe("group");
    expect(seen.target).toBe(BODY);
  });
});
