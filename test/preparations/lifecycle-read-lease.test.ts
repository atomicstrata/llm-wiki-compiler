/**
 * @file test/preparations/lifecycle-read-lease.test.ts
 * @description Production-boundary regressions for Task 9C lifecycle reads.
 *
 * Successful reads must be minted by the scanner, tied to one canonical
 * project root, and usable only while their callback lease is active — including
 * a capture one pass shares across its borrows.
 * Capture faults remain one bounded unavailable value rather than retrying.
 */

import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { makeTempRoot, useTempRoot } from "../fixtures/temp-root.js";
import {
  assertPreparationLifecycleRead,
  PreparationLifecycleReadError,
  preparationLifecycleReadPass,
  withPreparationLifecycleRead,
  type PreparationLifecycleReadV1,
} from "../../src/preparations/lifecycle-snapshot/read.js";
import { openPreparationLifecycleNamespace } from "../../src/preparations/lifecycle-fs/namespace.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";

describe("leased preparation lifecycle reads", () => {
  const root = useTempRoot();

  it("rejects a structurally forged successful read", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "read");
    const snapshot = await scanPreparationLifecycle(namespace);
    const forged = Object.freeze({ status: "ok", snapshot }) as PreparationLifecycleReadV1;
    await expect(assertPreparationLifecycleRead(root.dir, forged))
      .rejects.toBeInstanceOf(PreparationLifecycleReadError);
  });

  it("rejects a genuine clean read for another canonical project", async () => {
    const other = await makeTempRoot("lifecycle-read-other");
    try {
      await withPreparationLifecycleRead(root.dir, async (read) => {
        expect(read.status).toBe("ok");
        await expect(assertPreparationLifecycleRead(other, read))
          .rejects.toBeInstanceOf(PreparationLifecycleReadError);
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("accepts another lexical alias for the same canonical project", async () => {
    const alias = `${root.dir}-alias`;
    await symlink(root.dir, alias);
    try {
      await withPreparationLifecycleRead(root.dir, async (read) => {
        await expect(assertPreparationLifecycleRead(alias, read)).resolves.toBeUndefined();
      });
    } finally {
      await rm(alias);
    }
  });

  it("rejects a genuine read retained after its callback ends", async () => {
    let retained: PreparationLifecycleReadV1 | undefined;
    await withPreparationLifecycleRead(root.dir, (read) => {
      retained = read;
    });
    if (retained === undefined) throw new Error("lifecycle read callback was not invoked");
    await expect(assertPreparationLifecycleRead(root.dir, retained))
      .rejects.toBeInstanceOf(PreparationLifecycleReadError);
  });

  it("shares one pass capture across borrows, but leases it only inside each borrow", async () => {
    const pass = preparationLifecycleReadPass(root.dir);
    let first: PreparationLifecycleReadV1 | undefined;
    await pass.borrow((read) => { first = read; });
    if (first === undefined) throw new Error("lifecycle read callback was not invoked");
    await expect(assertPreparationLifecycleRead(root.dir, first)).rejects.toBeInstanceOf(PreparationLifecycleReadError);
    await pass.borrow(async (read) => {
      expect(read).toBe(first as PreparationLifecycleReadV1);
      await expect(assertPreparationLifecycleRead(root.dir, read)).resolves.toBeUndefined();
    });
    pass.close();
    await pass.borrow((read) => expect(read).not.toBe(first as PreparationLifecycleReadV1));
    await expect(assertPreparationLifecycleRead(root.dir, first)).rejects.toBeInstanceOf(PreparationLifecycleReadError);
  });

  it("returns one bounded unavailable result for namespace failure", async () => {
    const decoy = path.join(root.dir, "decoy");
    await mkdir(decoy);
    await symlink(decoy, path.join(root.dir, ".llmwiki"));
    let calls = 0;
    const retained = await withPreparationLifecycleRead(root.dir, (read) => {
      calls += 1;
      return read;
    });
    expect(calls).toBe(1);
    expect(retained.status).toBe("unavailable");
    if (retained.status !== "unavailable") throw new Error("expected unavailable read");
    expect(retained.detail.length).toBeLessThanOrEqual(128);
    expect(retained.detail).not.toContain(root.dir);
  });
});
