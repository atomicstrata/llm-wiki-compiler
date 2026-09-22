/**
 * @file test/preparation-gate-binding.test.ts
 * @description What a gate proof BINDS, and the readiness precondition both new
 * operations take.
 *
 * THREE CONTROLS THAT WERE LOAD-BEARING AND UNTESTED. Each was found by deleting
 * it and watching the whole suite stay green:
 *
 *  - the manifest-digest-to-binding match, which is what stops a proof being
 *    bound to a plan the run was never staged against (a TOCTOU on the second
 *    read: the binding is resolved from one inventory scan, and this module reads
 *    the manifest again);
 *  - the phase lookup by LOGICAL PHASE, rather than by array position — every
 *    other fixture carries exactly one summary, so nothing proved the proof binds
 *    the gate's OWN phase instance, and `phaseDigest` is precisely what
 *    revalidation enforces at effect time;
 *  - readiness, on both new operations.
 *
 * A control with no test is a control that is one refactor from being deleted by
 * someone who cannot see what it is for.
 */

import { describe, expect, it } from "vitest";
import { findApprovedGateProof, phaseBindingDigest } from "../src/preparations/gates.js";
import { resolveGateAuthority } from "../src/preparations/service-gate-authority.js";
import {
  appendPreparationTransitionLocked, readPreparationRun,
} from "../src/preparations/run-store.js";
import { preparationRunPredecessor } from "../src/preparations/run-integrity.js";
import { readPreparationManifest } from "../src/preparations/manifest-store.js";
import { canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { parseSha256Digest } from "../src/capability-providers/ids.js";
import { scanOperationInventory } from "../src/operation-bundles/capacity.js";
import { preparationKeyFile } from "../src/preparations/paths.js";
import { readFile, writeFile } from "node:fs/promises";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationGrant } from "../src/preparations/service.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { handoffObligations, stageReadyPreparation } from "./preparations/handoff-fixture.js";
import {
  DECOY_PHASE_ID, REVIEW_GATE_GRANTS, SEED_GATE_ID, currentPlanDigest, gateServiceOn,
  gatedRun, readGateRun,
  type GateFixture,
} from "./preparation-gate-fixture.js";

const root = useTempRoot();

/** Decide the fixture's gate through a granted `sdk` service. */
function decide(fixture: GateFixture) {
  return gateServiceOn(fixture.root, "sdk", REVIEW_GATE_GRANTS).gate({
    runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "approved",
  });
}

/** Append the `running -> recovery-required` park, a legal edge, under the lock. */
async function parkToRecoveryRequired(fixture: GateFixture): Promise<void> {
  await acquireLock(fixture.root, { quiet: true });
  try {
    const run = await readGateRun(fixture);
    await appendPreparationTransitionLocked(fixture.root, fixture.binding, preparationRunPredecessor(run), {
      type: "recovery-required", stateAfter: "recovery-required",
      actor: { id: "operator", surface: "cli" }, at: "2026-08-08T00:01:00.000Z",
      payload: { kind: "problem", code: "preparation-integrity-obligation" },
    });
  } finally {
    await releaseLock(fixture.root);
  }
}

/**
 * Corrupt the preparation key so the project cannot be acted in, and return the
 * repair.
 *
 * The repair exists because the DURABLE half of a readiness refusal cannot be
 * observed while the key is broken — the run leaf is key-bound, so a test that
 * simply asserted "no proof" would be asserting that an unreadable record is
 * empty. Restoring the exact bytes and reading the run back is what actually
 * distinguishes "refused before writing" from "wrote and then refused".
 */
async function breakPreparationKey(dir: string): Promise<() => Promise<void>> {
  const file = preparationKeyFile(dir);
  const original = await readFile(file, "utf8");
  await writeFile(file, `${original.slice(0, -2)}!!`, "utf8");
  return () => writeFile(file, original, "utf8");
}

describe("a gate proof binds the plan the run was staged against", () => {
  it("refuses when the manifest no longer matches the run's binding digest", async () => {
    const fixture = await gatedRun("gatebinddrift");
    try {
      const read = await readPreparationRun(fixture.root, fixture.binding);
      if (read.status !== "ok") throw new Error(`run ${read.status}`);
      // The TOCTOU shape, exactly: a binding whose recorded manifest digest is
      // not the digest of the manifest this module reads. Nothing else in the
      // resolver notices — the plan parses, the gate is declared, the phase
      // exists — so this is the only check standing between a caller and a proof
      // bound to bytes the run never agreed to.
      const drifted = { ...fixture.binding, manifestDigest: parseSha256Digest(`sha256:${"1".repeat(64)}`) };
      const authority = await resolveGateAuthority(fixture.root, drifted, read.run, SEED_GATE_ID);
      expect(authority.ok).toBe(false);
      expect(!authority.ok && authority.reason).toMatch(/manifest digest changed/);
    } finally { await fixture.cleanup(); }
  });

  it("binds the GATE'S phase instance, not whichever summary is first", async () => {
    // The run carries a decoy summary ahead of the gate's own. Reading by array
    // position would bind `phaseDigest` to the decoy, and revalidation at effect
    // time compares exactly that dimension.
    const fixture = await gatedRun("gatephasefind", { decoyPhase: true });
    try {
      await decide(fixture);
      const run = await readGateRun(fixture);
      expect(run.phaseSummaries[0]?.phaseInstanceId).toBe(DECOY_PHASE_ID);
      expect(run.gateProofs[0]?.phaseDigest).toBe(phaseBindingDigest(fixture.phaseInstanceId));
      expect(run.gateProofs[0]?.phaseDigest).not.toBe(phaseBindingDigest(DECOY_PHASE_ID));
    } finally { await fixture.cleanup(); }
  });
});

describe("both new operations refuse a project they cannot act in", () => {
  it("gate refuses on an unreadable key and records no proof", async () => {
    const fixture = await gatedRun("gatereadiness");
    try {
      const repair = await breakPreparationKey(fixture.root);
      const result = await decide(fixture);
      expect(result).toMatchObject({ status: "refused" });
      expect(result.status === "refused" && result.reason).toMatch(/preparation key is unreadable/);
      // THE DURABLE HALF, which the title claims and an earlier revision never
      // checked. Its handoff sibling asserts the empty bundle inventory; this is
      // the same assertion in this operation's own terms, and it needs the key
      // back because the run leaf is key-bound.
      await repair();
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it("handoff refuses on an unreadable key and creates no bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const obligations = handoffObligations(binding);
    await breakPreparationKey(root.dir);

    const result = await createPreparationService({
      root: root.dir, surface: "sdk",
      principals: { principalFor: () => ({ id: "host-2", surface: "sdk", grants: ["preparation.run"] }) },
    }).handoff({ runId: binding.runId, obligations });
    expect(result).toMatchObject({ status: "refused" });
    expect(result.status === "refused" && result.reason).toMatch(/preparation key is unreadable/);
    expect((await scanOperationInventory(root.dir)).manifests).toHaveLength(0);
  });
});

describe("a recorded proof outlives the state it was recorded in", () => {
  it("is still found after the run parks to recovery-required", async () => {
    // MEASURED, because the slice's first deferral of abandonment argued the
    // opposite from a true premise. Both halves of that derivation hold — a
    // decision is only RECORDABLE at `running`/`awaiting-gate`, and
    // `recovery-required` has no self-edge — but the conclusion did not: nothing
    // binds a durable proof to the state it was written in, so an approval
    // recorded before the park is found after it, which is exactly where an
    // abandonment path would consume one. A structural blocker is a thing to
    // test, not a thing to argue.
    const fixture = await gatedRun("gateparksurvive", { gateKind: "confirm-abandonment" });
    try {
      await gateServiceOn(fixture.root, "sdk", ["preparation.abandon"]).gate({
        runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "approved",
      });
      await parkToRecoveryRequired(fixture);
      const run = await readGateRun(fixture);
      expect(run.state).toBe("recovery-required");
      expect(findApprovedGateProof(run.gateProofs, SEED_GATE_ID, await currentPlanDigest(fixture)))
        .toBeDefined();
    } finally { await fixture.cleanup(); }
  });
});

/**
 * Record one decision under a named kind and require that NOTHING moved.
 *
 * The two halves travel together because "records authority and performs nothing"
 * is one claim: a case asserting only the recorded status passes against a gate
 * that also starts the protocol its kind governs.
 */
async function expectRecordsOnly(
  prefix: string, gateKind: string, grant: PreparationGrant,
): Promise<void> {
  const fixture = await gatedRun(prefix, { gateKind });
  try {
    const result = await gateServiceOn(fixture.root, "sdk", [grant]).gate({
      runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "approved",
    });
    expect(result).toMatchObject({ status: "recorded" });
    const run = await readGateRun(fixture);
    expect(run.gateProofs).toHaveLength(1);
    expect(run.state).toBe("running");
    expect(run.effectSummaries).toHaveLength(0);
    expect(run.brokerRequestSummaries).toHaveLength(0);
    expect(run.residualFindings).toHaveLength(0);
  } finally { await fixture.cleanup(); }
}

describe("every gate kind records and performs nothing", () => {
  it("an effect-class gate records under the EFFECT grant and starts no effect", async () => {
    // The kind whose approval `effects.ts` consumes — so "the gate does not
    // start it" is the claim worth pinning, not merely that it was recorded.
    await expectRecordsOnly("gateeffectkind", "confirm-external-effect", "preparation.effect.approve");
  });

  it("an abandonment gate records under the ABANDON grant and abandons nothing", async () => {
    await expectRecordsOnly("gateabandonkind", "confirm-abandonment", "preparation.abandon");
  });
});
