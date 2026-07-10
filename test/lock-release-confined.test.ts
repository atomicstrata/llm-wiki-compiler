/**
 * @file test/lock-release-confined.test.ts
 * @description Audit FIX — `releaseLock` is confined to the project root.
 *
 * Before this fix `releaseLock` did a RAW `unlink(path.join(root, ".llmwiki/lock"))`
 * with NO confinement. On a project whose `.llmwiki` is a symlink escaping the
 * root, that `path.join` + `unlink` FOLLOWED the symlink and deleted a victim
 * file OUTSIDE the project root. It also derived the lock path differently from
 * `acquireLock` (raw join vs confined realpath), so on a realpath-divergent root
 * the two could disagree and leave the lock unreleased.
 *
 * Now `releaseLock` derives the lock path the SAME confined way as `acquireLock`,
 * via the NO-MKDIR read resolver: it never creates `.llmwiki`, never follows an
 * escaping symlink, and shares the `lockFileIn` derivation so acquire/release
 * always agree on the path.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import {
  makeRootWithOutside,
  cleanupRootWithOutside,
  existsUnder,
  exists,
  expectLockAcquireRelease,
} from "./trust/fixture.js";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  ({ root, outsideDir } = await makeRootWithOutside("lock-release-confine-"));
});

afterEach(async () => {
  await cleanupRootWithOutside({ root, outsideDir });
});

describe("FIX — releaseLock confines the private .llmwiki dir to the root", () => {
  it("SECURITY: never unlinks a victim through an escaping .llmwiki symlink", async () => {
    const victim = path.join(outsideDir, "lock");
    await writeFile(victim, "do-not-delete", "utf-8");
    await symlink(outsideDir, path.join(root, LLMWIKI_DIR), "dir");

    // acquireLock must refuse the escaping .llmwiki up front.
    expect(await acquireLock(root)).toBe(false);
    // releaseLock must NOT follow the symlink and delete the outside victim.
    await releaseLock(root);
    expect(await exists(victim)).toBe(true);
  });

  it("roundtrip on a normal root: acquire → release → re-acquire all succeed", async () => {
    await expectLockAcquireRelease(root);
    // Release actually removed the lock acquire created — a re-acquire is clean.
    expect(await acquireLock(root)).toBe(true);
    await releaseLock(root);
  });

  it("roundtrip on a realpath-divergent root: acquire/release agree on the path", async () => {
    // Reach the real project root via a symlink so realpath(link) !== link. If
    // acquire and release derived the path differently, release would miss the
    // lock and the re-acquire would report "another running".
    const link = await mkdtemp(path.join(tmpdir(), "lock-release-link-"));
    const linkedRoot = path.join(link, "root");
    await symlink(root, linkedRoot, "dir");
    try {
      expect(await acquireLock(linkedRoot)).toBe(true);
      await releaseLock(linkedRoot);
      expect(await acquireLock(linkedRoot)).toBe(true);
      await releaseLock(linkedRoot);
    } finally {
      await rm(link, { recursive: true, force: true });
    }
  });

  it("absent .llmwiki: releaseLock is a no-op and does NOT create the dir", async () => {
    expect(await existsUnder(root, LLMWIKI_DIR)).toBe(false);
    await expect(releaseLock(root)).resolves.toBeUndefined();
    // The no-mkdir resolver must leave the clean project untouched.
    expect(await existsUnder(root, LLMWIKI_DIR)).toBe(false);
  });
});
