/**
 * @file test/atomic-write-no-replace-durable-review.test.ts
 * @description Review regressions for create-only durable publication after
 * the destination link commits: cleanup failures remain explicit, and a
 * swapped parent can never be mistaken for a successful confined write.
 */

import { link, lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AtomicWriteCollisionError,
  AtomicWriteCommittedCleanupError,
  atomicWrite,
  atomicWriteNoReplaceDurable,
} from "../src/utils/atomic-write.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

describe("durable no-replace post-commit failures", () => {
  it("promotes and cleans an exact ready-only crash state", async () => {
    await expectCrashStateRecovery("ready-only", ".tmp", "body");
  });

  it.each([
    ["zero-length", ""],
    ["partial", "bo"],
    ["complete", "body"],
  ])("retries after a %s scratch-only crash state", async (_state, scratchContent) => {
    await expectCrashStateRecovery(`scratch-${_state}`, ".writing", scratchContent);
  });

  it("preserves and refuses a special scratch leaf", async () => {
    const parent = path.join(root.dir, "special-scratch");
    const target = path.join(parent, "record");
    const scratch = `${target}.writing`;
    await mkdir(parent);
    await symlink("elsewhere", scratch);

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
    })).rejects.toBeInstanceOf(AtomicWriteCommittedCleanupError);

    expect((await lstat(scratch)).isSymbolicLink()).toBe(true);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a crash-left committed temp alias on collision replay", async () => {
    const parent = path.join(root.dir, "crash-alias");
    const target = path.join(parent, "record");
    const alias = `${target}.tmp`;
    await mkdir(parent);
    await atomicWriteNoReplaceDurable(target, "body", { confineRoot: root.dir });
    await link(target, alias);

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);

    expect(await readdir(parent)).toEqual(["record"]);
  });

  it("never deletes a foreign file planted in the reserved temp namespace", async () => {
    const parent = path.join(root.dir, "foreign-crash-alias");
    const target = path.join(parent, "record");
    const alias = `${target}.tmp`;
    await mkdir(parent);
    await atomicWriteNoReplaceDurable(target, "body", { confineRoot: root.dir });
    await writeFile(alias, "foreign");

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
    })).rejects.toBeInstanceOf(AtomicWriteCommittedCleanupError);

    expect(await readFile(alias, "utf8")).toBe("foreign");
  });

  // Writes 4097 sequential leaves; I/O-bound and slow on some temp filesystems.
  it("replays in a valid directory with more than 4096 sibling leaves", { timeout: 120_000 }, async () => {
    const parent = path.join(root.dir, "large-store");
    const target = path.join(parent, "record");
    await mkdir(parent);
    await atomicWriteNoReplaceDurable(target, "body", { confineRoot: root.dir });
    for (let index = 0; index < 4_097; index += 1) {
      await writeFile(path.join(parent, `blob-${index}`), "x");
    }

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    // Sequentially materializing 4,097 sibling leaves is filesystem-bound and
    // can exceed the default timeout on a loaded host; the assertion itself is
    // cheap.
  });

  it("syncs an exact existing leaf before reporting its collision", async () => {
    const parent = path.join(root.dir, "collision-file-sync");
    const target = path.join(parent, "record");
    const failure = new Error("injected existing-file sync failure");
    await mkdir(parent);
    await writeFile(target, "body");

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeExistingFileSyncForTest: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it.each([
    ["oversized", "body and more"],
    ["same-length divergent", "fork"],
  ])("skips leaf fsync for a %s existing collision", async (caseName, collisionContent) => {
    const parent = path.join(root.dir, `${caseName.replaceAll(" ", "-")}-collision`);
    const target = path.join(parent, "record");
    let synced = false;
    await mkdir(parent);
    await writeFile(target, collisionContent);

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeExistingFileSyncForTest: async () => { synced = true; },
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);

    expect(synced).toBe(false);
  });

  it("syncs through a canonical project root when its lexical root is a symlink", async () => {
    const actualRoot = path.join(root.dir, "actual-root");
    const linkedRoot = path.join(root.dir, "linked-root");
    const target = path.join(linkedRoot, "records", "record");
    await mkdir(actualRoot);
    await symlink(actualRoot, linkedRoot, "dir");

    await atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: linkedRoot,
      exactParent: true,
    });

    expect(await readFile(target, "utf8")).toBe("body");
  });

  it("surfaces a typed committed cleanup failure", async () => {
    const parent = path.join(root.dir, "cleanup");
    const target = path.join(parent, "record");
    await mkdir(parent);

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: async () => {
        const temp = (await readdir(parent)).find((item) => item.endsWith(".tmp"));
        if (temp === undefined) throw new Error("missing committed temp alias");
        await unlink(path.join(parent, temp));
        await mkdir(path.join(parent, temp));
      },
    });

    const failure = await writing.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtomicWriteCommittedCleanupError);
    expect(await readFile(target, "utf8")).toBe("body");
  });

  it("rejects after a committed destination parent is swapped", async () => {
    const parent = path.join(root.dir, "swapped");
    const moved = path.join(root.dir, "swapped-original");
    const target = path.join(parent, "record");
    await mkdir(parent);

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: async () => {
        await rename(parent, moved);
        await mkdir(parent);
      },
    });

    await expect(writing).rejects.toThrow(/changed|cleanup/i);
    expect(await readFile(path.join(moved, "record"), "utf8")).toBe("body");
  });

  it.each(["removed", "replaced"] as const)("rejects when the committed destination is %s", async (action) => {
    const parent = path.join(root.dir, action);
    const target = path.join(parent, "record");
    await mkdir(parent);

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: async () => {
        await unlink(target);
        if (action === "replaced") await writeFile(target, "replacement");
      },
    });

    await expect(writing).rejects.toThrow(/destination.*changed|destination.*bound/i);
    expect((await readdir(parent)).filter((item) => item.endsWith(".tmp"))).toEqual([]);
  });

  it("does not unlink a foreign replacement of the committed temp alias", async () => {
    const parent = path.join(root.dir, "foreign-temp");
    const target = path.join(parent, "record");
    await mkdir(parent);
    let foreignTemp = "";

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: async () => {
        const tempName = (await readdir(parent)).find((item) => item.endsWith(".tmp"));
        if (tempName === undefined) throw new Error("missing committed temp alias");
        foreignTemp = path.join(parent, tempName);
        await unlink(foreignTemp);
        await writeFile(foreignTemp, "foreign");
      },
    });

    await expect(writing).rejects.toBeInstanceOf(AtomicWriteCommittedCleanupError);
    expect(await Promise.all([readFile(foreignTemp, "utf8"), readFile(target, "utf8")]))
      .toEqual(["foreign", "body"]);
  });

  it("rechecks the destination after directory fsync", async () => {
    const parent = path.join(root.dir, "post-sync");
    const target = path.join(parent, "record");
    await mkdir(parent);
    let replaced = false;

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeDirectorySyncForTest: async (dir) => {
        if (replaced || dir !== parent || !(await readdir(parent)).includes("record")) return;
        replaced = true;
        await unlink(target);
        await writeFile(target, "replacement");
      },
    });

    await expect(writing).rejects.toThrow(/destination.*changed|destination.*bound/i);
  });

  it("syncs each successor alias before removing its predecessor", async () => {
    const parent = path.join(root.dir, "successor-sync-order");
    const target = path.join(parent, "record");
    const observed: string[][] = [];
    await mkdir(parent);

    await atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeDirectorySyncForTest: async (dir) => {
        if (dir === parent) observed.push((await readdir(parent)).sort());
      },
    });

    expect(observed).toEqual([
      ["record.tmp", "record.writing"],
      ["record", "record.tmp"],
      ["record"],
    ]);
  });

  it("preserves both aliases when ready-link directory sync fails", async () => {
    const parent = path.join(root.dir, "ready-sync-failure");
    const target = path.join(parent, "record");
    const failure = new Error("injected ready-link sync failure");
    await mkdir(parent);

    await expect(atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeDirectorySyncForTest: async (dir) => {
        if (dir === parent) throw failure;
      },
    })).rejects.toBe(failure);

    expect((await readdir(parent)).sort()).toEqual(["record.tmp", "record.writing"]);
    await atomicWriteNoReplaceDurable(target, "body", { confineRoot: root.dir });
    expect(await readdir(parent)).toEqual(["record"]);
  });

  it("rejects a parent swapped only while its directory entry is synced", async () => {
    const parent = path.join(root.dir, "sync-swap");
    const moved = path.join(root.dir, "sync-swap-original");
    const target = path.join(parent, "record");
    await mkdir(parent);
    let swapped = false, restored = false;
    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeDirectorySyncForTest: async (dir) => {
        const destinationExists = dir === parent && (await readdir(parent)).includes("record");
        if (destinationExists && !swapped) {
          await rename(parent, moved); await mkdir(parent); swapped = true;
        } else if (dir === root.dir && swapped && !restored) {
          await rm(parent, { recursive: true }); await rename(moved, parent); restored = true;
        }
      },
    });

    const failure = await writing.then(() => undefined, (error: unknown) => error);
    if (!restored) {
      await rm(parent, { recursive: true }); await rename(moved, parent); restored = true;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/changed|bound|redirect|symlink|cleanup/i);
    expect(await readFile(target, "utf8")).toBe("body");
  });

  it("rejects a boundary swap that relocates the genuine published inode", async () => {
    const parent = path.join(root.dir, "relocated");
    const target = path.join(parent, "record");
    const moved = path.join(parent, "genuine");
    await mkdir(parent);
    const relocate = relocateGenuineOnce(target, moved);

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      beforeDirectorySyncForTest: async (dir) => {
        if (dir === parent && (await readdir(parent)).includes("record")) await relocate();
      },
    });

    await expectRelocationRejected(writing, moved, target);
  });

  it("rejects a promotion boundary swap of a recovered crash temp", async () => {
    const parent = path.join(root.dir, "recovered-swap");
    const target = path.join(parent, "record");
    const moved = path.join(parent, "genuine");
    await mkdir(parent);
    await writeFile(`${target}.tmp`, "body");

    const writing = atomicWriteNoReplaceDurable(target, "body", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: relocateGenuineOnce(target, moved),
    });

    await expectRelocationRejected(writing, moved, target);
  });
});

/** Relocate the genuine published inode aside and plant an impostor once. */
function relocateGenuineOnce(target: string, moved: string): () => Promise<void> {
  let swapped = false;
  return async () => {
    if (swapped) return;
    swapped = true;
    await rename(target, moved);
    await writeFile(target, "impostor");
  };
}

/** Assert a boundary swap is refused and the genuine bytes survive relocated. */
async function expectRelocationRejected(writing: Promise<void>, moved: string, target: string): Promise<void> {
  await expect(writing).rejects.toThrow(/destination.*changed|destination.*bound/i);
  expect(await Promise.all([readFile(moved, "utf8"), readFile(target, "utf8")]))
    .toEqual(["body", "impostor"]);
}

/** Seed one reserved crash leaf and verify replay leaves only the target. */
async function expectCrashStateRecovery(parentName: string, suffix: string, initialContent: string): Promise<void> {
  const parent = path.join(root.dir, parentName);
  const target = path.join(parent, "record");
  await mkdir(parent);
  await writeFile(`${target}${suffix}`, initialContent);

  await atomicWriteNoReplaceDurable(target, "body", { confineRoot: root.dir });

  expect(await readFile(target, "utf8")).toBe("body");
  expect(await readdir(parent)).toEqual(["record"]);
}

describe("strict overwrite destination binding", () => {
  it.each(["removed", "replaced"] as const)("rejects when the synced destination is %s", async (action) => {
    const parent = path.join(root.dir, `strict-${action}`);
    const target = path.join(parent, "record");
    const replacement = path.join(parent, "older-record");
    await mkdir(parent);
    await writeFile(target, "old");
    if (action === "replaced") await writeFile(replacement, "older-valid-run");
    let mutated = false;

    const writing = atomicWrite(target, "new-authority", {
      confineRoot: root.dir,
      exactParent: true,
      strictDurability: true,
      beforeDirectorySyncForTest: async () => {
        if (mutated) return;
        mutated = true;
        if (action === "removed") await unlink(target);
        else await rename(replacement, target);
      },
    });

    await expect(writing).rejects.toThrow(/destination.*changed|destination.*bound/i);
  });
});
