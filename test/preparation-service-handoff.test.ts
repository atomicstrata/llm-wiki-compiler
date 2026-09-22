/**
 * @file test/preparation-service-handoff.test.ts
 * @description The `handoff` operation's own behaviour at the service seam.
 *
 * WHAT THIS FILE PROVES AND WHAT IT DOES NOT. It proves the SEAM: that the
 * operation authorizes against the host principal, refuses every inadmissible run
 * without touching the substrate's lock, routes an admissible one through the
 * self-locking entry point rather than reconstructing it, and reports the
 * substrate's typed refusal as a returned value. It does NOT prove that a
 * production run ever reaches this operation with obligations in hand — nothing
 * in `src/` produces a compilation yet, and the fixture is what supplies one.
 * That limit is stated because a suite this green is easy to read as more.
 *
 * THE ROUTING ASSERTION IS THE CRASH RESUME. Reconstructing handoff from
 * settlement plus a transition append — the shape an earlier operation table
 * described — would produce a correct-looking happy path and lose the
 * reserved-identity resume entirely. So the case that discriminates is the one
 * that crashes mid-flow and requires the SAME bundle identity back.
 */

import { describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type { HandoffResultV1, PreparationGrant } from "../src/preparations/service.js";
import { PrincipalAuthorityError } from "../src/preparations/service.js";
import { readPreparationRun } from "../src/preparations/run-store.js";
import { scanOperationInventory } from "../src/operation-bundles/capacity.js";
import { handoffPreparation } from "../src/preparations/handoff.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import {
  CRASH_AFTER_STAGE, CRASH_BEFORE_STAGE, handoffObligations, handoffObligationsUncompilable,
  handoffRequest, stageDivergentReservedGenesis, stageReadyPreparation,
} from "./preparations/handoff-fixture.js";
import { stageRunIn } from "./preparation-recovery-fixture.js";

const root = useTempRoot();

/** The grant handoff costs — the RUN grant, never `operation-bundle.approve`. */
const HANDOFF_GRANTS: readonly PreparationGrant[] = ["preparation.run"];

/** The service a granted SDK host would construct. */
function service(dir: string, grants: readonly PreparationGrant[] = HANDOFF_GRANTS) {
  return createPreparationService({
    root: dir, surface: "sdk",
    principals: { principalFor: () => ({ id: "host-2", surface: "sdk", grants }) },
  });
}

/** Hand off one bound run through a granted `sdk` service. */
function handoff(
  dir: string, binding: PreparationRunBinding, grants = HANDOFF_GRANTS,
): Promise<HandoffResultV1> {
  return service(dir, grants).handoff({
    runId: binding.runId, obligations: handoffObligations(binding),
  });
}

/** Assert the run reached `handed-off` BOUND to the bundle the result named. */
async function expectHandedOffTo(
  binding: PreparationRunBinding, result: HandoffResultV1,
): Promise<void> {
  if (result.status === "refused") throw new Error(`expected a handoff, got: ${result.reason}`);
  const read = await readPreparationRun(root.dir, binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  expect(read.run.state).toBe("handed-off");
  // The BINDING, not just the state: a handoff that settled the transition
  // without recording which bundle it produced would satisfy the state alone.
  expect(read.run.handoff?.bundleId).toBe(result.bundleId);
}

describe("handoff routes one settled run through the self-locking entry point", () => {
  it("stages the bundle and drives the run to handed-off", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoff(root.dir, binding);
    expect(result).toMatchObject({ status: "handed-off", runId: binding.runId });
    await expectHandedOffTo(binding, result);
  });

  it("resumes the EXACT reserved identity after a crash, minting no second bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    // A real crash at the durable `handoff-started` boundary, through the
    // substrate's own deterministic seam.
    await expect(handoffPreparation(root.dir, {
      ...handoffRequest(binding), faultsForTest: CRASH_BEFORE_STAGE,
    })).rejects.toThrow();
    const resumed = await handoff(root.dir, binding);
    expect(resumed).toMatchObject({ status: "resumed" });
    // ONE bundle, not two: the reconstruction shape would have minted a second.
    const inventory = await scanOperationInventory(root.dir);
    expect(inventory.manifests).toHaveLength(1);
  });

  it("credits the HOST principal on the durable handoff transition", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await handoff(root.dir, binding);
    const run = await readPreparationRun(root.dir, binding);
    expect(run.status === "ok" && run.run.transitions.at(-1)?.actor)
      .toMatchObject({ id: "host-2", surface: "sdk" });
  });
});

/**
 * Assert one refusal for the right reason AND that no bundle exists.
 *
 * The inventory read is the load-bearing half: a refusal that staged first and
 * reported second satisfies the returned status alone, so the two assertions
 * travel together rather than being re-typed per case.
 */
async function expectRefusedWithNoBundle(
  result: HandoffResultV1, reason: RegExp,
): Promise<void> {
  expect(result).toMatchObject({ status: "refused" });
  expect(result.status === "refused" && result.reason).toMatch(reason);
  expect((await scanOperationInventory(root.dir)).manifests).toHaveLength(0);
}

describe("a resume re-verifies IDENTITY, not authority", () => {
  it("completes after a rejection recorded in the staged-but-unsettled window", async () => {
    // THE EXACT WINDOW. `settleHandoff` stages the Milestone A bundle BEFORE it
    // appends `handed-off`, so a crash between them leaves `handoff-started` with
    // the bundle already on disk.
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, {
      ...handoffRequest(binding), faultsForTest: CRASH_AFTER_STAGE,
    })).rejects.toThrow();
    expect((await scanOperationInventory(root.dir)).manifests).toHaveLength(1);
    // THE PROBE. The resume is handed a compilation the intent compiler REFUSES
    // — an unsettled operator obligation, which is the same `needs-operator-
    // pending` refusal a rejected gate proof produces through `assertSettled`. If
    // the resume consulted the compiler at all it would refuse forever
    // (`handoff-started` admits no edge to `cancelling`, so the run would
    // strand), undoing an already staged bundle, which design 17.3 forbids.
    // Succeeding here is positive evidence that the resume proved the reserved
    // IDENTITY instead of re-running authority.
    const resumed = await service(root.dir).handoff({
      runId: binding.runId, obligations: handoffObligationsUncompilable(binding),
    });
    expect(resumed).toMatchObject({ status: "resumed" });
    await expectHandedOffTo(binding, resumed);
    // NOT STRANDED, and no second bundle was minted to get there.
    expect((await scanOperationInventory(root.dir)).manifests).toHaveLength(1);
  });

  it("still refuses a bundle staged under a DIVERGENT genesis authority", async () => {
    // The identity-only path relaxes nothing: the manifest digest is invariant to
    // the genesis authority, so this is the only check that catches a bundle
    // staged under the reserved identity with a different control budget — and it
    // goes through the same derivation the recovery leg uses.
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, {
      ...handoffRequest(binding), faultsForTest: CRASH_BEFORE_STAGE,
    })).rejects.toThrow();
    await stageDivergentReservedGenesis(root.dir, binding);
    const result = await handoff(root.dir, binding);
    expect(result).toMatchObject({ status: "refused" });
    expect(result.status === "refused" && result.reason).toMatch(/digest-conflict/);
  });
});

describe("handoff refuses without reaching the substrate", () => {
  it("refuses a run that is not settled, and creates no bundle", async () => {
    // A freshly staged run is `planned`, which the substrate's own exported
    // startable set excludes — so the pre-check and the executor agree.
    const staged = await stageRunIn(root.dir);
    await expectRefusedWithNoBundle(await handoff(root.dir, staged.binding), /only a settled run/);
  });

  it("refuses an unknown run rather than throwing", async () => {
    await stageReadyPreparation(root.dir);
    const result = await service(root.dir).handoff({
      runId: "prr_00000000000000000000000000000000",
      obligations: handoffObligations(await stageReadyPreparation(root.dir)),
    });
    expect(result.status).toBe("refused");
  });

  it("refuses an obligation set missing a required field", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const { payloads: _dropped, ...incomplete } = handoffObligations(binding);
    const result = await service(root.dir)
      .handoff({ runId: binding.runId, obligations: incomplete as never });
    await expectRefusedWithNoBundle(result, /obligation set is incomplete/);
  });
});

describe("handoff costs the run grant, not the bundle-approval grant", () => {
  it("THROWS missing-grant for a principal holding only the approval grant", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoff(root.dir, binding, ["operation-bundle.approve"]))
      .rejects.toBeInstanceOf(PrincipalAuthorityError);
    expect((await scanOperationInventory(root.dir)).manifests).toHaveLength(0);
  });

  it("and the run grant alone is enough — staging is not approving", async () => {
    const binding = await stageReadyPreparation(root.dir);
    expect(await handoff(root.dir, binding, ["preparation.run"]))
      .toMatchObject({ status: "handed-off" });
  });
});
