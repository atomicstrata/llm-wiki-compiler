/**
 * @file test/portable/h1-resolve-decisions.test.ts
 * @description H1-R: the operator's way out of a crashed publication,
 * `operation.resolve`, and the recovery it reruns, witnessed on the real disk
 * protocol through the public session (spec §8.4 step 7, §8.7).
 *
 * - Recovery reverts a target the crashed operation CREATED by removing it,
 *   leaving a target still at its pre-image untouched.
 * - A resolve naming an operation that is not parked (committed, or never
 *   allocated) refuses `not_parked` and changes nothing.
 * - If a target moves between the resolver's observation and its action, the
 *   resolve refuses `targets_changed` and closes nothing.
 * - `accept-external-bytes` after a real hand edit records `abandoned` with
 *   what it observed, keeps the edited bytes, and unblocks the project.
 * - `retry-recovery` on an intent that still cannot be decided stays parked
 *   and writes nothing.
 *
 * Every publication is made by the real publish code, interrupted at a named
 * protocol stage (`h1-helpers.ts`). Process-crash snapshots, not power-loss tests.
 */

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { bytesDigest } from "../../src/portable/digest.js";
import {
  afterFirstObservation, closeRecorded, freshWorldPerTest, intentPresent, labelRecord, PAIR, pairWrites, preimageFile, publishCrashing,
  readSource, seedKept, sourceFile, sourceText, type H1World,
} from "./h1-helpers.js";
import { prepared } from "./helpers.js";

let world: H1World;
freshWorldPerTest((fresh) => { world = fresh; });

const OLD = PAIR.old;
const NEW = PAIR.replaced;
const ADDED = PAIR.added;
const HAND_EDIT = "edited by hand after the crash\n";

/** A source's bytes now, or `null` when it is absent. */
const source = (name: string): Promise<string | null> => sourceText(world, name);

/** True when the durable close record of `operationId` exists. */
const closed = (operationId: string): Promise<boolean> => closeRecorded(world, operationId);

/** Seed, then crash `op` after both writes and replace `kept.md` by hand: parked on a target at neither image. */
async function parkedByHandEdit(): Promise<void> {
  await seedKept(world);
  await publishCrashing(world, pairWrites(world), "after-writes");
  await writeFile(sourceFile(world, "kept.md"), HAND_EDIT);
}

describe("recovery after a crash that created a file", () => {
  it("removes the file the operation created and leaves the target still at its pre-image", async () => {
    await seedKept(world);
    // Creation first: the crash leaves added.md at its post-image and kept.md at its pre-image.
    await publishCrashing(world, [...pairWrites(world)].reverse(), "after-target", 1);
    expect([await source("kept.md"), await source("added.md")]).toEqual([OLD.toString(), ADDED]);
    expect(await world.session.project.status("op")).toMatchObject({ kind: "refused", code: "recovered_no_effect", detail: "rolled_back" });
    expect([await source("kept.md"), await source("added.md")]).toEqual([OLD.toString(), null]);
    expect(await labelRecord(world, "sources/added.md")).toBeNull();
    expect(await labelRecord(world, "sources/kept.md")).toMatchObject({ digest: bytesDigest(OLD), labels: world.restricted });
    expect(await intentPresent(world, "op")).toBe(false);
  });
});

describe("a resolve naming an operation that is not parked", () => {
  it("refuses not_parked for a committed operation and for an unknown id, changing nothing", async () => {
    await seedKept(world);
    const { project } = world.session;
    expect((await project.status("seed")).kind).toBe("committed");
    for (const operationId of ["seed", "never-allocated"]) {
      for (const decision of ["roll-back-own-writes", "accept-external-bytes"] as const) {
        expect(await project.resolve({ operationId, decision, reason: "not parked" })).toEqual({ kind: "refused", code: "not_parked" });
      }
    }
    expect(await source("kept.md")).toBe(OLD.toString());
    expect([await closed("seed"), await closed("never-allocated")]).toEqual([false, false]);
    expect((await project.status("seed")).kind).toBe("committed");
  });
});

describe("a target that moves between the resolver's two observations", () => {
  it("refuses targets_changed, writes nothing and closes nothing", async () => {
    await parkedByHandEdit();
    // After the first observation, the edited target is put back at its pre-image (neither → pre-image).
    const { outcome, observations } = await afterFirstObservation(
      () => writeFile(sourceFile(world, "kept.md"), OLD),
      () => world.session.project.resolve({ operationId: "op", decision: "accept-external-bytes", reason: "keep the edit" }),
    );
    expect(outcome).toEqual({ kind: "refused", code: "targets_changed" });
    expect(observations).toBe(2);
    expect([await source("kept.md"), await source("added.md")]).toEqual([OLD.toString(), ADDED]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await closed("op")).toBe(false);
  });
});

describe("accept-external-bytes after a real hand edit", () => {
  it("records abandoned with its observation, keeps the edited bytes and unblocks the project", async () => {
    await parkedByHandEdit();
    const { project } = world.session;
    expect(await project.status("op")).toEqual({ kind: "unknown", operationId: "op" });
    expect(await readSource(world.session, "kept.md")).toEqual({ refused: "publication_in_progress" });
    expect(await project.resolve({ operationId: "op", decision: "roll-back-own-writes", reason: "try" })).toEqual({ kind: "refused", code: "decision_not_allowed" });
    const resolved = await project.resolve({ operationId: "op", decision: "accept-external-bytes", reason: "keep the edit" });
    expect(resolved).toMatchObject({ kind: "resolved", status: { kind: "abandoned", operationId: "op" } });
    const targets = resolved.kind === "resolved" && resolved.status.kind === "abandoned" ? resolved.status.resolution.targets : null;
    expect(targets).toEqual([{ path: "sources/kept.md", observed: "neither" }, { path: "sources/added.md", observed: "post-image" }]);
    expect([await source("kept.md"), await source("added.md")]).toEqual([HAND_EDIT, ADDED]);
    expect(await intentPresent(world, "op")).toBe(false);
    expect(await readSource(world.session, "kept.md")).not.toEqual({ refused: "publication_in_progress" });
    const added = await project.sources.add({ operationId: await project.allocateOperation(), name: "after.md", upload: prepared("# After\n") });
    expect(added.kind).toBe("committed");
    expect((await project.status("op")).kind).toBe("abandoned");
  });
});

describe("retry-recovery while the cause is still present", () => {
  it("stays parked and writes nothing when a retained pre-image is still corrupt", async () => {
    await seedKept(world);
    await publishCrashing(world, pairWrites(world), "after-target", 1);
    await writeFile(preimageFile(world, OLD), "corrupted\n");
    const { project } = world.session;
    expect(await project.status("op")).toEqual({ kind: "unknown", operationId: "op" });
    const outcome = await project.resolve({ operationId: "op", decision: "retry-recovery", reason: "cause not repaired" });
    expect(outcome).toEqual({ kind: "resolved", status: { kind: "unknown", operationId: "op" } });
    expect([await source("kept.md"), await source("added.md")]).toEqual([NEW, null]);
    expect(await readFile(preimageFile(world, OLD), "utf8")).toBe("corrupted\n");
    expect([await intentPresent(world, "op"), await closed("op")]).toEqual([true, false]);
    expect(await readSource(world.session, "kept.md")).toEqual({ refused: "publication_in_progress" });
  });
});
