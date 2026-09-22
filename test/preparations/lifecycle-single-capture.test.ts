/**
 * @file test/preparations/lifecycle-single-capture.test.ts
 * @description One lifecycle capture per complete read-only decision, the corpus
 * that decision is counted over, and the lifecycle states the mutation gate must
 * refuse.
 *
 * The third block is not about capture counting: it pins a pre-existing gap where
 * the gate reported clean over an unfinished key reset. It lives here rather than
 * beside the other gate regressions because those are in the frozen Task 9A corpus,
 * which cannot take an edit. It inherits this file's fs mock without needing it.
 *
 * Chunk 2 put a lifecycle read inside `scanPreparationInventory`, so reference
 * composition began enumerating both registries TWICE per call — once through
 * capacity and once through its own pendingness probe. That is not only wasted
 * I/O: the two halves of a single answer observe different filesystem states, so
 * a unit settled between them is counted inconsistently within one decision.
 *
 * This counts exact registry-root `opendir` calls on the real production path
 * rather than asserting structure, because structure and parity cannot express
 * "once". It fails at two captures and passes only at one.
 */

import { describe, expect, it, vi } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";

const listingProbe = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    opendir: async (directory: Parameters<typeof actual.opendir>[0]) => {
      listingProbe.calls.push(String(directory));
      return actual.opendir(directory);
    },
  };
});

import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { plantRegistrySymlink, redirectLlmwiki } from "./lifecycle-storage-fixture.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import {
  LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, tamperRun,
} from "./lifecycle-fixture.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../../src/preparations/reset.js";
import {
  lifecycleSnapshotFixture, writeQuarantineReceipts,
} from "./lifecycle-snapshot-fixture.js";
import { resolvePreparationLifecyclePending } from "../../src/preparations/recovery.js";

/**
 * Exact `opendir` count for one physical lifecycle registry root. Matched by
 * suffix because the scanner resolves the root, and on macOS the temp path is
 * reported as its /private realpath rather than the fixture's own string.
 */
function rootOpens(segment: string): number {
  const suffix = path.join(".llmwiki", segment);
  return listingProbe.calls.filter((candidate) => candidate.endsWith(suffix)).length;
}

/** Both registries must exist, or an absent registry is never enumerated. */
async function presentRegistries(dir: string): Promise<void> {
  await mkdir(path.join(dir, ".llmwiki", "preparation-quarantine"), { recursive: true });
  await mkdir(path.join(dir, ".llmwiki", "preparation-prune"), { recursive: true });
}

/**
 * Registries AND a real staged preparation. Counting against empty registries
 * with zero manifests leaves every per-item path outside the counted window: a
 * second capture inside the manifest enumeration loop is then invisible, which is
 * exactly the regression this file exists to catch. The inventory must be
 * non-empty for the count to mean anything.
 */
async function populatedRoot(dir: string): Promise<void> {
  await presentRegistries(dir);
  // ORDER MATTERS: lifecycleSnapshotFixture writes a fresh preparation key, so
  // running it AFTER staging rotates the epoch out from under the staged run and
  // leaves it integrity-invalid. That silently moves the healthy-run branch of
  // manifestReference OUT of the counted window as the error leg moves in — the
  // same blind spot as counting against empty registries, one branch over.
  const fixture = await lifecycleSnapshotFixture(dir);
  await stagePreparation(dir);
  // A tampered preparation too, so manifestReference's ERROR leg is inside the
  // window as well as its success leg. Declaring the corpus by exclusion pinned
  // the window SHUT: it forbade any error state, so a second capture on that leg
  // was invisible and widening the fixture would have failed the declaration.
  const tampered = await stagePreparation(dir);
  await tamperRun(dir, tampered.binding);
  // A real quarantine unit, so per-UNIT paths are inside the counted window too.
  // Staging alone gives a manifest but zero lifecycle units, which left a second
  // capture on any per-unit path invisible to the counter.
  await writeQuarantineReceipts({
    namespace: fixture.namespace, key: fixture.key, keyEpochId: fixture.keyEpochId,
    unitId: "qtn-countedcountedcountedcount", scope: "per-run",
    objects: [], completed: true,
  });
  // A PENDING unit as well. With only a completed one, lifecyclePending is false
  // and the body of that branch never runs inside the counted window — the fourth
  // instance of this fixture leaving a branch cold, after empty registries, zero
  // units, and a rotated key.
  await writeQuarantineReceipts({
    namespace: fixture.namespace, key: fixture.key, keyEpochId: fixture.keyEpochId,
    unitId: "qtn-pendingpendingpendingpendi", scope: "per-run", objects: [],
  });
}

describe("one lifecycle capture per complete decision", () => {
  const root = useTempRoot();

  it("enumerates each lifecycle registry once per reference/GC decision", async () => {
    await populatedRoot(root.dir);
    listingProbe.calls.length = 0;
    await enumeratePreparationReferences(root.dir);
    expect({
      quarantine: rootOpens("preparation-quarantine"),
      prune: rootOpens("preparation-prune"),
    }).toEqual({ quarantine: 1, prune: 1 });

    // Declare the CORPUS by INCLUSION. A count cannot see its own window shrinking,
    // and five fixtures running have proved it: empty registries, zero units, a
    // rotated key, a completed-only unit, and then a declaration written as an
    // exclusion, which pinned the window shut instead of open.
    //
    // Inclusion is the form that permits widening and fails narrowing. Each name
    // below is a branch of the counted decision that must stay reachable — both
    // legs of manifestReference, and both the pending and completed unit states.
    //
    // Branches deliberately outside this window cannot be reached by ANY corpus and
    // are not fixture gaps: an unavailable capture performs no opendir at all, so
    // the counter is structurally blind there, as it is to bound exhaustion and the
    // supersession throw. Those need a different instrument, not a richer fixture.
    const references = await enumeratePreparationReferences(root.dir);
    const states = [...new Set(references.references.map((reference) => reference.state))].sort();
    expect(states).toEqual(["integrity-invalid", "planned"]);
    expect(references.problems.map((problem) => problem.dimension).sort())
      .toEqual(["quarantine", "run-state"]);

    // Unit states are declared separately because neither assertion above observes
    // one: dropping the completed unit changes no reference state, and the pending
    // unit supplies the `quarantine` dimension on its own. The comment claimed both
    // unit states were declared while nothing asserted either — a control's comment
    // is not evidence of its coverage, including a comment written while fixing
    // exactly that. This capture sits after the count assertion, so it is outside
    // the counted window and cannot disturb it.
    const unitStates = await withPreparationLifecycleRead(root.dir, (read) =>
      (read.status === "ok" ? read.snapshot.units.map((unit) => unit.state).sort() : []));
    expect(unitStates).toEqual(["completed", "planned"]);
  });

  it("enumerates each lifecycle registry once per status/recovery decision", async () => {
    await populatedRoot(root.dir);
    listingProbe.calls.length = 0;
    await resolvePreparationLifecyclePending(root.dir);
    expect({
      quarantine: rootOpens("preparation-quarantine"),
      prune: rootOpens("preparation-prune"),
    }).toEqual({ quarantine: 1, prune: 1 });
  });
});

describe("supplied-read consumers agree across every lifecycle state", () => {
  const root = useTempRoot();

  /** References completeness and the lifecycle gate must never disagree. */
  async function parity(dir: string): Promise<{ complete: boolean; status: string }> {
    return {
      complete: (await enumeratePreparationReferences(dir)).complete,
      status: (await resolvePreparationLifecyclePending(dir)).status,
    };
  }

  it("reports clean state as complete and clean", async () => {
    await presentRegistries(root.dir);
    expect(await parity(root.dir)).toEqual({ complete: true, status: "clean" });
  });

  it("holds GC and refuses the gate on a genuinely unavailable capture", async () => {
    // A redirected .llmwiki fails the namespace binding, so the CAPTURE itself is
    // unavailable. The sibling test below plants a symlink inside a registry,
    // which yields snapshot PROBLEMS with read.status === "ok" — a different leg.
    // Nothing previously exercised the unavailable-capture branch on either
    // consumer, so the disjunct that handles it was unpinned.
    await redirectLlmwiki(root.dir);

    const observed = await parity(root.dir);
    expect(observed.complete).toBe(false);
    expect(observed.status).toBe("unavailable");

    // Assert the PENDING leg specifically. Completeness alone is carried by the
    // capacity lifecycle-storage problem as well, so inverting the unavailable
    // disjunct in lifecyclePending leaves `complete` false and goes unnoticed.
    const dimensions = (await enumeratePreparationReferences(root.dir))
      .problems.map((problem) => problem.dimension);
    expect(dimensions).toContain("quarantine");
  });

  it("holds GC and refuses the gate on unavailable physical state", async () => {
    const quarantine = path.join(root.dir, ".llmwiki", "preparation-quarantine");
    await mkdir(quarantine, { recursive: true });
    await mkdir(path.join(root.dir, ".llmwiki", "preparation-prune"), { recursive: true });
    await plantRegistrySymlink(root.dir, quarantine);

    const observed = await parity(root.dir);
    expect(observed.complete).toBe(false);
    expect(observed.status).toBe("unavailable");
  });

  it("keeps readable classifier-unknown content incomplete for GC yet usable for capacity", async () => {
    // Both halves must be asserted on ONE state. Asserting only that references
    // are incomplete cannot distinguish the required outcome from the forbidden
    // one: if the readable foreign file became a CAPACITY problem — the staging
    // dead end V2 section 5.3 exists to prevent — references would read incomplete
    // too, and the test would pass for exactly the wrong reason.
    await presentRegistries(root.dir);
    await writeFile(path.join(root.dir, ".llmwiki", "preparation-quarantine", "foreign"), "readable");

    const references = await enumeratePreparationReferences(root.dir);
    expect(references.complete).toBe(false);
    // Incomplete for the LIFECYCLE reason, not a capacity fault.
    expect(references.problems.map((problem) => problem.dimension)).toEqual(["quarantine"]);

    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    expect(inventory.quarantine.health).toBe("ok");
  });
});

describe("the gate refuses a reset awaiting its continuation", () => {
  const root = useTempRoot();

  it("reports the pending RESET, not clean, for awaiting-continuation", async () => {
    // Pre-existing coverage debt, pinned here because the gate is what LICENSES
    // mutations. `unitPending` lists four states; this is the one FOUND unpinned,
    // not established as the only one — dropping `unavailable` also left the set I
    // re-ran green, so that state's pinning depends on suites outside it.
    // Dropping awaiting-continuation left 59 tests green while resolvePreparationLifecyclePending
    // reported "clean" over a project holding an unfinished key reset waiting on an
    // operator continuation token — precisely the state settlePendingIntents exists
    // to refuse. The GC leg does not mask it either; references stays incomplete
    // only because the removed key raises a run-state capacity problem.
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const first = await resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: "2026-07-29T00:00:00.000Z",
      confirmation: MISSING_KEY_CONFIRMATION,
    });
    expect(first.status).toBe("intent-recorded");

    // AND THE OPERATION, which is the half the projection used to discard. The
    // status alone said "something is unfinished"; it hardcoded a quarantine
    // label over four different operations, so no consumer could tell the reset
    // that blocks every other destructive command from a sibling that does not.
    expect(await resolvePreparationLifecyclePending(root.dir)).toMatchObject({
      status: "pending",
      units: [{ registry: "quarantine", operation: "project-key-reset" }],
    });
  });
});
