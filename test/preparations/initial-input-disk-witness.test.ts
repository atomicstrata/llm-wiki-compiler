/**
 * @file test/preparations/initial-input-disk-witness.test.ts
 * @description ONE DISK WITNESS for the run lookup's sealed-input read. It
 * stages one preparation with the shared fixture in a fresh temporary directory
 * and calls the lookup's ROOT FORM, `readPreparationInitialInput(root, manifest)`,
 * on the manifest that staging returned. The fixture freezes `SEED_VALUE` as
 * the run's initial input, so the read must return exactly that record. The
 * whole result is asserted, against the fixture's own constant.
 *
 * WHAT THIS RUNS. The real evidence read on the local disk, for the success
 * path only: one staged evidence object, read back by location and digest under
 * the plan's byte count, then decoded.
 *
 * WHAT THIS DOES NOT RUN. It calls the lookup's function directly. It does NOT
 * execute the execution-provenance verifier's sealed-input closure, which is
 * that verifier's own line calling this function; that closure and the
 * verifier's run closure are executed by no test. It shows none of the
 * sealed-input refusals on disk (absent, unavailable, over-cap, mismatch, not
 * JSON, not an object); `test/storage/preparation-run-lookup-binding.test.ts`
 * reaches those through the real body over a double. It says nothing about a
 * run read or a key read.
 *
 * It uses only the root form, so it runs unchanged before and after the
 * lookup's reads were made rootless.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { readPreparationInitialInput } from "../../src/preparations/service-run-lookup.js";
import { stagePreparation } from "./lifecycle-fixture.js";
import { SEED_VALUE } from "./store-fixture.js";

describe("run lookup: the sealed-input read on the local disk (root form, success path only)", () => {
  it("W2 returns exactly the seed the fixture staged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "initial-input-disk-witness-"));
    try {
      const { manifest } = await stagePreparation(root);
      expect(await readPreparationInitialInput(root, manifest)).toEqual({ ok: true, record: SEED_VALUE });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
