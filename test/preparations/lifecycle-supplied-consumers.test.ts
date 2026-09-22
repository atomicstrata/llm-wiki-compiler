/**
 * @file test/preparations/lifecycle-supplied-consumers.test.ts
 * @description Root and lease authority regressions for supplied lifecycle
 * capacity. A genuine read is useful only inside its capture callback and only
 * for the canonical project that minted it.
 */

import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeTempRoot, useTempRoot } from "../fixtures/temp-root.js";
import {
  scanPreparationInventoryFromLifecycle,
} from "../../src/preparations/capacity.js";
import {
  PreparationLifecycleReadError,
  withPreparationLifecycleRead,
  type PreparationLifecycleReadV1,
} from "../../src/preparations/lifecycle-snapshot/read.js";

describe("supplied lifecycle capacity authority", () => {
  const root = useTempRoot();

  it("rejects a genuine project-A read for project-B capacity", async () => {
    const other = await makeTempRoot("capacity-other-root");
    try {
      await withPreparationLifecycleRead(root.dir, async (read) => {
        await expect(scanPreparationInventoryFromLifecycle(other, read))
          .rejects.toMatchObject({ code: "read-root-mismatch" });
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("rejects a genuine read retained after its callback", async () => {
    let retained: PreparationLifecycleReadV1 | undefined;
    await withPreparationLifecycleRead(root.dir, (read) => {
      retained = read;
    });
    if (retained === undefined) throw new Error("read callback was not invoked");
    await expect(scanPreparationInventoryFromLifecycle(root.dir, retained))
      .rejects.toMatchObject({ code: "read-expired" });
  });
});
