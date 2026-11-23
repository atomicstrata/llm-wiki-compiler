/**
 * @file test/portable/h1-crash-stages.test.ts
 * @description H1: a two-target publication — one replacing an existing
 * restricted source, one adding a new one — interrupted before its receipt at
 * each protocol stage, then settled by recovery or by an operator.
 *
 * After the intent or the started marker nothing was written and it closes as
 * a known no-effect. After a PREFIX of the writes the operation's own write is
 * reverted, bytes and labels. After every write it rolls forward and commits.
 * A missing or corrupt pre-image parks BEFORE any rollback write; once it is
 * repaired, `retry-recovery` or `roll-back-own-writes` settles it honestly.
 * Settled outcomes are stable under repeated recovery. Process-crash snapshots,
 * not power-loss tests.
 */

import { rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { bytesDigest } from "../../src/portable/digest.js";
import type { PublishFaultStage } from "../../src/portable/store/store.js";
import {
  freshWorldPerTest, labelRecord, pairWrites, preimageFile, publishCrashing, readSource, seedKept, sourceText, type H1World,
} from "./h1-helpers.js";

let world: H1World;
freshWorldPerTest((fresh) => { world = fresh; });

const OLD = Buffer.from("# Old\n");

/** Seed `kept.md`, then publish its replacement plus a new `added.md` as `op`, crashing at `stage` (the `nth` time). */
async function crashedPair(stage: PublishFaultStage, nth = 1): Promise<void> {
  await seedKept(world);
  await publishCrashing(world, pairWrites(world), stage, nth);
}

/** The two targets' bytes now (`null` when absent). */
async function targets(): Promise<[string | null, string | null]> {
  return [await sourceText(world, "kept.md"), await sourceText(world, "added.md")];
}

describe("a crash before any target was written", () => {
  it("closes after the intent as never started, writing nothing", async () => {
    await crashedPair("after-intent");
    expect(await world.session.project.status("op")).toMatchObject({ kind: "refused", detail: "never_started" });
    expect(await targets()).toEqual(["# Old\n", null]);
  });

  it("closes after the started marker as no surviving effect, writing nothing", async () => {
    await crashedPair("after-started");
    expect(await world.session.project.status("op")).toMatchObject({ kind: "refused", detail: "no_surviving_effect" });
    expect(await targets()).toEqual(["# Old\n", null]);
  });
});

describe("a crash after some or all target writes", () => {
  it("reverts its own write after a prefix, bytes and labels, and records rolled back", async () => {
    await crashedPair("after-target", 1);
    expect(await targets()).toEqual(["# New\n", null]);
    expect(await world.session.project.status("op")).toMatchObject({ kind: "refused", detail: "rolled_back" });
    expect(await targets()).toEqual(["# Old\n", null]);
    expect(await labelRecord(world, "sources/kept.md")).toMatchObject({ digest: bytesDigest(OLD), labels: world.restricted });
    expect(await world.session.project.status("op")).toMatchObject({ kind: "refused", detail: "rolled_back" });
  });

  it("rolls forward after every write and commits with the intended labels", async () => {
    await crashedPair("after-writes");
    expect((await world.session.project.status("op")).kind).toBe("committed");
    expect(await targets()).toEqual(["# New\n", "# Added\n"]);
    expect((await labelRecord(world, "sources/added.md"))?.labels).toEqual(world.restricted);
  });
});

describe("a pre-image that cannot be restored", () => {
  it("parks before any rollback write, then settles by retry-recovery once repaired", async () => {
    await crashedPair("after-target", 1);
    await rm(preimageFile(world, OLD));
    expect(await world.session.project.status("op")).toEqual({ kind: "unknown", operationId: "op" });
    expect(await targets()).toEqual(["# New\n", null]);
    expect(await readSource(world.session, "kept.md")).toEqual({ refused: "publication_in_progress" });
    await writeFile(preimageFile(world, OLD), OLD);
    const resolved = await world.session.project.resolve({ operationId: "op", decision: "retry-recovery", reason: "pre-image restored" });
    expect(resolved).toMatchObject({ kind: "resolved", status: { kind: "refused", detail: "rolled_back" } });
    expect(await targets()).toEqual(["# Old\n", null]);
  });

  it("parks on a corrupt pre-image, refuses the rollback, then rolls back its own write once repaired", async () => {
    await crashedPair("after-target", 1);
    await writeFile(preimageFile(world, OLD), "corrupted\n");
    expect(await world.session.project.status("op")).toEqual({ kind: "unknown", operationId: "op" });
    const refused = await world.session.project.resolve({ operationId: "op", decision: "roll-back-own-writes", reason: "try" });
    expect(refused).toEqual({ kind: "refused", code: "decision_not_allowed" });
    expect(await targets()).toEqual(["# New\n", null]);
    await writeFile(preimageFile(world, OLD), OLD);
    const resolved = await world.session.project.resolve({ operationId: "op", decision: "roll-back-own-writes", reason: "repaired" });
    expect(resolved).toMatchObject({ kind: "resolved", status: { kind: "refused", detail: "rolled_back" } });
    expect(await targets()).toEqual(["# Old\n", null]);
    expect(await world.session.project.status("op")).toMatchObject({ kind: "refused", detail: "rolled_back" });
  });
});
