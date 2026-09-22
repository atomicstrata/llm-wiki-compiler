/**
 * @file test/atomic-write-no-replace-final9.test.ts
 * @description Decision 19 regressions keep candidate no-replace publication
 * honest: it has no durable-success mode, and a dynamic durable request must be
 * refused before any destination or parent-directory effect.
 */

import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  atomicWriteNoReplace,
  AtomicWriteCommittedCleanupError,
  AtomicWriteNoReplaceDurabilityUnsupportedError,
} from "../src/utils/atomic-write.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

/** Publish ordinarily while the test seam removes or replaces its destination. */
async function publishAcrossDestinationChange(action: "removed" | "replaced") {
  const directory = path.join(root.dir, `ordinary-${action}`);
  const destination = path.join(directory, "candidate.json");
  await mkdir(directory);
  return atomicWriteNoReplace(destination, "authority", {
    confineRoot: root.dir,
    afterNoReplaceCommitForTest: async () => {
      await unlink(destination);
      if (action === "replaced") await writeFile(destination, "replacement");
    },
  });
}

describe("Final9 candidate no-replace durability boundary", () => {
  it("refuses a dynamic durable request before creating its parent", async () => {
    const parent = path.join(root.dir, "new-parent");
    const target = path.join(parent, "candidate.json");

    const writing = atomicWriteNoReplace(target, "authority", { durable: true } as never);

    await expect(writing).rejects
      .toBeInstanceOf(AtomicWriteNoReplaceDurabilityUnsupportedError);
    await expect(access(parent)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not advertise durable in the TypeScript option shape", async () => {
    const target = path.join(root.dir, "candidate.json");

    if (false) {
      // @ts-expect-error Candidate no-replace publication intentionally omits durable.
      await atomicWriteNoReplace(target, "authority", { durable: true });
    }
    expect(target).toContain("candidate.json");
  });

  it("refuses a dynamic strict-durability request before creating its parent", async () => {
    const parent = path.join(root.dir, "strict-parent");
    const target = path.join(parent, "candidate.json");

    const writing = atomicWriteNoReplace(target, "authority", {
      strictDurability: true,
    } as never);

    await expect(writing).rejects
      .toBeInstanceOf(AtomicWriteNoReplaceDurabilityUnsupportedError);
    await expect(access(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not advertise strict durability or directory-sync hooks", async () => {
    const target = path.join(root.dir, "candidate.json");

    if (false) {
      // @ts-expect-error Candidate no-replace publication omits strict durability.
      await atomicWriteNoReplace(target, "authority", { strictDurability: true });
      // @ts-expect-error Candidate no-replace publication omits directory-sync hooks.
      await atomicWriteNoReplace(target, "authority", { beforeDirectorySyncForTest: async () => {} });
    }
    expect(target).toContain("candidate.json");
  });

  it.each(["removed", "replaced"] as const)("does not report success when its destination is %s", async (action) => {
    await expect(publishAcrossDestinationChange(action)).rejects
      .toThrow(/destination.*changed|destination.*bound/i);
    const directory = path.join(root.dir, `ordinary-${action}`);
    expect((await readdir(directory)).filter((item) => item.endsWith(".tmp"))).toEqual([]);
  });

  it("does not unlink a foreign replacement of the ordinary temp alias", async () => {
    const directory = path.join(root.dir, "ordinary-foreign-temp");
    const destination = path.join(directory, "candidate.json");
    await mkdir(directory);
    let foreignTemp = "";

    const writing = atomicWriteNoReplace(destination, "authority", {
      confineRoot: root.dir,
      afterNoReplaceCommitForTest: async () => {
        foreignTemp = path.join(directory, (await readdir(directory)).find((item) => item.endsWith(".tmp"))!);
        await unlink(foreignTemp);
        await writeFile(foreignTemp, "foreign");
      },
    });

    await expect(writing).rejects.toBeInstanceOf(AtomicWriteCommittedCleanupError);
    expect(await readFile(foreignTemp, "utf8")).toBe("foreign");
    expect(await readFile(destination, "utf8")).toBe("authority");
  });
});
