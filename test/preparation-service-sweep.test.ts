/**
 * @file test/preparation-service-sweep.test.ts
 * @description The `sweep` service operation — the only destructive operation
 * whose target is an OBSERVATION rather than a function of its request, and
 * therefore the one the gate ticket exists for.
 *
 * THREE ANSWERS ARE TESTED AS THREE. `nothing-to-sweep` is the ordinary outcome
 * on a healthy project and is a SUCCESS; a refusal is a call that could not act;
 * and the unreadable-key case is a refusal rather than an empty success, because
 * a project whose key cannot classify owners is not a project with no orphans.
 * These were one nullable value one layer down, and a surface reporting the
 * first for the third would tell an operator something false about a delete.
 */

import { gateDecision } from "./preparations/lifecycle-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { sweepPreparationOrphansLocked } from "../src/preparations/retention.js";
import { LifecycleAuthorizationDivergedError } from "../src/preparations/lifecycle-driver.js";
import { cliPreparationService } from "../src/commands/preparation/host.js";
import { expectBusyLockRefusal, orphanOnePreparation } from "./preparation-destructive-fixture.js";
import {
  LIFECYCLE_ACTOR, makePreparationKeyUnreadable, pruneStagedThenCrashed, removePreparationKey,
  stagePreparation, sweepStagedThenCrashed,
} from "./preparations/lifecycle-fixture.js";

const AT = "2026-08-08T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-service-sweep-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("sweep: reclaiming orphans", () => {
  it("reclaims a preparation whose run is provably absent", async () => {
    await orphanOnePreparation(root);
    const outcome = await cliPreparationService(root).sweep();
    expect(outcome).toMatchObject({ status: "swept", resumed: false });
    if (outcome.status !== "swept") return;
    expect(outcome.objectCount).toBeGreaterThan(0);
    expect((await scanPreparationInventory(root)).manifests.length).toBe(0);
  });

  it("resumes a crashed sweep on the unit the gate authorized", async () => {
    const unitId = await sweepStagedThenCrashed(root, AT);
    expect(await cliPreparationService(root).sweep())
      .toMatchObject({ status: "swept", unitId, resumed: true });
    expect((await resolvePreparationLifecyclePending(root)).status).toBe("clean");
  });

  it("reports nothing-to-sweep on a healthy project as a SUCCESS", async () => {
    await stagePreparation(root);
    expect(await cliPreparationService(root).sweep()).toEqual({ status: "nothing-to-sweep" });
  });
});

describe("sweep: could-not-tell is never reported as nothing-to-do", () => {
  it("refuses at the READINESS leg when the key is unreadable", async () => {
    await orphanOnePreparation(root);
    await makePreparationKeyUnreadable(root);
    expect(await cliPreparationService(root).sweep()).toMatchObject({
      status: "refused", reason: expect.stringContaining("preparation commands cannot proceed"),
    });
    // The orphan is still there, so the refusal cost nothing and can be retried
    // once the key is readable.
    expect((await scanPreparationInventory(root)).manifests.length).toBe(1);
  });

  it("refuses at the CLASSIFICATION leg when the key is absent", async () => {
    // A DIFFERENT LEG, and it took a mutant to notice they were not the same.
    // An unreadable key is refused by readiness before the operation starts; an
    // ABSENT key is the healthy pre-staging state that readiness deliberately
    // admits, so it reaches the substrate — which cannot classify an orphan's
    // owner without it and must say so rather than report an empty project.
    // Written against the unreadable case alone, this cell certified the
    // readiness message while the arm it names went untested.
    await orphanOnePreparation(root);
    await removePreparationKey(root);
    expect(await cliPreparationService(root).sweep()).toMatchObject({
      status: "refused", reason: expect.stringContaining("orphan's owner cannot be classified"),
    });
    expect((await scanPreparationInventory(root)).manifests.length).toBe(1);
  });

  it("refuses a busy lock rather than reporting an empty project", async () => {
    await orphanOnePreparation(root);
    await expectBusyLockRefusal(root, () => cliPreparationService(root).sweep(), 1);
  });

  it("refuses while an unfinished PRUNE occupies the registry", async () => {
    const { unitId } = await pruneStagedThenCrashed(root, AT);
    expect(await cliPreparationService(root).sweep()).toMatchObject({
      status: "refused", reason: expect.stringContaining(unitId),
    });
  });
});

// THE CLASS CHANGED AND THE SCENARIOS DID NOT. These two exercised a
// sweep-specific comparison of the authorized unit id; that comparison was a
// strict subset of the driver's re-evaluation and has been removed, so the same
// two states now refuse one layer earlier through the gate's own predicate.
// Kept rather than deleted precisely so the deletion cannot cost coverage: if
// either state ever stopped refusing, these fail.
describe("sweep: the executor refuses a target the gate did not authorize", () => {
  it("refuses when its own capture resolves a different unit", async () => {
    // The comparison the ticket exists for, exercised at the substrate where it
    // lives. The gate authorized nothing; a capture that finds a pending unit is
    // therefore acting on work no acquisition approved, and it must refuse
    // rather than adopt whichever unit it happened to see.
    const unitId = await sweepStagedThenCrashed(root, AT);
    await expect(sweepPreparationOrphansLocked(root, {
      actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep"),
    })).rejects.toBeInstanceOf(LifecycleAuthorizationDivergedError);
    // NOTHING WAS TOUCHED: the comparison runs before the key read and before
    // any planning, so the unit is exactly as it was.
    expect(await resolvePreparationLifecyclePending(root)).toMatchObject({
      status: "pending", units: [{ operation: "orphan-sweep", unitId }],
    });
  });

  it("refuses a named unit the registry no longer holds", async () => {
    await orphanOnePreparation(root);
    await expect(sweepPreparationOrphansLocked(root, {
      actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep", undefined, "swp-not-here"),
    })).rejects.toBeInstanceOf(LifecycleAuthorizationDivergedError);
    expect((await scanPreparationInventory(root)).manifests.length).toBe(1);
  });
});
