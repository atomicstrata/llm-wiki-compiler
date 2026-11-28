/**
 * @file test/portable/h1-resolve-observation-digest.test.ts
 * @description H1-R, spec §8.7: "If the targets change between the observation
 * and the action, the action is refused and nothing is done."
 *
 * The resolver observes a parked intent's targets twice under the gate and acts
 * only when the two observations show the SAME exact bytes: the same content
 * digest, or absence, for every target. The class alone (pre-image, post-image,
 * neither) is not enough: a hand-edited target replaced by a DIFFERENT hand edit
 * stays "neither" while its bytes change. A target whose bytes cannot be read
 * within the bounded confined read is never proven unchanged, so it cannot be
 * accepted as external bytes until it is readable again. Eligibility is decided
 * again on the final observation, so a retained pre-image repaired in between
 * withdraws the abandonment it had allowed.
 *
 * The digests are internal evidence only: the durable resolution record, status
 * and the public response keep the closed `{ path, observed }` shape. Nothing
 * here protects against a non-cooperating writer after the final observation.
 */

import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import type { PublishFaultStage } from "../../src/portable/store/store.js";
import { ledgerPath } from "./disk-format-helpers.js";
import {
  afterFirstObservation, closeRecorded, freshWorldPerTest, intentPresent, PAIR, pairWrites, preimageFile, publishCrashing, seedKept, sourceFile,
  sourceText, type H1World,
} from "./h1-helpers.js";

let world: H1World;
freshWorldPerTest((fresh) => { world = fresh; });

const OLD = PAIR.old;
const ADDED = PAIR.added;
const FIRST_EDIT = "first hand edit\n";

/** Seed `kept.md`, then publish [replace kept.md, create added.md] as `op`, crashing at `stage` (the `nth` time). */
async function crashedPair(stage: PublishFaultStage, nth = 1): Promise<void> {
  await seedKept(world);
  await publishCrashing(world, pairWrites(world), stage, nth);
}

/** A source's bytes now, or `null` when it is absent. */
const source = (name: string): Promise<string | null> => sourceText(world, name);

/**
 * The ledger's durable state for `op`: whether its close record exists, and the bytes of its identity record(s).
 * Only `op`'s own records: the first gated call legitimately settles the seed's in-progress identity.
 */
async function durableState(): Promise<{ closed: boolean; identities: string[] }> {
  const dir = ledgerPath(world.fixture, "identity", "");
  const all = await Promise.all((await readdir(dir)).sort().map((name) => readFile(`${dir}/${name}`, "utf8")));
  const identities = all.filter((text) => JSON.parse(text).operationId === "op");
  expect(identities).toHaveLength(1);
  return { closed: await closeRecorded(world, "op"), identities };
}

/** Resolve `op` while `between` runs once, right after the resolver's FIRST observation. */
async function resolveWithChange(decision: "accept-external-bytes" | "roll-back-own-writes", between: () => Promise<void>): Promise<unknown> {
  const { outcome } = await afterFirstObservation(between, () => world.session.project.resolve({ operationId: "op", decision, reason: "operator decision" }));
  return outcome;
}

/** The keys of every object in `targets`, sorted, to catch internal evidence leaking into a durable or public shape. */
function targetKeys(targets: readonly object[]): string[][] {
  return targets.map((target) => Object.keys(target).sort());
}

describe("a parked target replaced by a different hand edit between the two observations", () => {
  it("refuses targets_changed, keeps both targets' external bytes, and records no close or identity change", async () => {
    await crashedPair("after-writes");
    await writeFile(sourceFile(world, "kept.md"), FIRST_EDIT);
    const before = await durableState();
    const outcome = await resolveWithChange("accept-external-bytes", () => writeFile(sourceFile(world, "kept.md"), "second, different hand edit\n"));
    expect(outcome).toEqual({ kind: "refused", code: "targets_changed" });
    expect([await source("kept.md"), await source("added.md")]).toEqual(["second, different hand edit\n", ADDED]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });
});

describe("stable targets, one absent and one hand-edited", () => {
  it("abandons as before and keeps the closed { path, observed } shape in the response, status and durable record", async () => {
    await crashedPair("after-target", 1);
    await writeFile(sourceFile(world, "kept.md"), FIRST_EDIT);
    const resolved = await world.session.project.resolve({ operationId: "op", decision: "accept-external-bytes", reason: "keep the edit" });
    const expected = [{ path: "sources/kept.md", observed: "neither" }, { path: "sources/added.md", observed: "pre-image" }];
    expect(resolved).toMatchObject({ kind: "resolved", status: { kind: "abandoned", resolution: { targets: expected } } });
    const status = await world.session.project.status("op");
    const record = JSON.parse(await readFile(ledgerPath(world.fixture, "closed", "op.json"), "utf8"));
    for (const targets of [(resolved as any).status.resolution.targets, (status as any).resolution.targets, record.resolution.targets]) {
      expect(targetKeys(targets)).toEqual([["observed", "path"], ["observed", "path"]]);
    }
    expect([await source("kept.md"), await source("added.md")]).toEqual([FIRST_EDIT, null]);
  });
});

describe("a parked target that cannot be read within the bounded confined read", () => {
  it("refuses accept-external-bytes while unreadable, stays parked, and abandons once readable again", async () => {
    await crashedPair("after-writes");
    await writeFile(sourceFile(world, "kept.md"), FIRST_EDIT);
    await chmod(sourceFile(world, "kept.md"), 0o000);
    const before = await durableState();
    const refused = await world.session.project.resolve({ operationId: "op", decision: "accept-external-bytes", reason: "keep the edit" });
    expect(refused).toEqual({ kind: "refused", code: "decision_not_allowed" });
    expect(await world.session.project.status("op")).toEqual({ kind: "unknown", operationId: "op" });
    expect(await durableState()).toEqual(before);
    // Operator recovery: make the target a readable regular file again, then resolve.
    await chmod(sourceFile(world, "kept.md"), 0o644);
    const resolved = await world.session.project.resolve({ operationId: "op", decision: "accept-external-bytes", reason: "keep the edit" });
    expect(resolved).toMatchObject({ kind: "resolved", status: { kind: "abandoned" } });
    expect([await source("kept.md"), await source("added.md")]).toEqual([FIRST_EDIT, ADDED]);
  });

  it("refuses targets_changed when the target becomes unreadable between the two observations", async () => {
    await crashedPair("after-writes");
    await writeFile(sourceFile(world, "kept.md"), FIRST_EDIT);
    const before = await durableState();
    try {
      const outcome = await resolveWithChange("accept-external-bytes", () => chmod(sourceFile(world, "kept.md"), 0o000));
      expect(outcome).toEqual({ kind: "refused", code: "targets_changed" });
    } finally {
      await chmod(sourceFile(world, "kept.md"), 0o644);
    }
    expect(await source("kept.md")).toBe(FIRST_EDIT);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });
});

describe("a retained pre-image repaired between the two observations", () => {
  it("decides eligibility again on the final observation and withdraws the abandonment", async () => {
    await crashedPair("after-target", 1);
    await writeFile(preimageFile(world, OLD), "corrupted\n");
    const before = await durableState();
    // The first observation allows honest abandonment (a pre-image cannot be restored); the final one does not.
    const outcome = await resolveWithChange("accept-external-bytes", () => writeFile(preimageFile(world, OLD), OLD));
    expect(outcome).toEqual({ kind: "refused", code: "decision_not_allowed" });
    expect([await source("kept.md"), await source("added.md")]).toEqual(["# New\n", null]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });
});
