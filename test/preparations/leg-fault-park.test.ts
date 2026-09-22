/**
 * @file test/preparations/leg-fault-park.test.ts
 * @description A required leg's FAULT parks the RUN, not merely the phase — and
 * the parked run is operator-recoverable.
 *
 * THE DEFECT THIS CLOSES. A faulting leg settles with an unknown-state phase.
 * That outcome used to reach `settle`, which appends `stateAfter: "running"`
 * while its projector CLEARS the execution owner. The result was an ownerless
 * `running` run carrying a `recovery-required` leg, and that state had no
 * operator exit at all — three shipped behaviours composed into a strand:
 *
 *   1. Re-driving skips it. The runner drives a phase only from `pending` or
 *      `ready`, and `recovery-required` does not satisfy a required successor,
 *      so fixing the cause (installing the missing tool) and re-driving still
 *      leaves the successor blocked.
 *   2. `recovery` refuses. It parks a run that HOLDS an execution owner, and
 *      the settle had already cleared it — "no attempt to park".
 *   3. `abandon` refuses. It requires the RUN to be `recovery-required`, and
 *      this run is still `running`.
 *
 * The fix routes the fault through the same park every other recoverable
 * failure already takes, so the existing recovery model applies rather than a
 * new escape hatch. These arms pin the OPERATOR-VISIBLE consequence — the run
 * is parked, says why, and can be abandoned — because "the leg parked
 * correctly" and "the operator can get out" are different claims and only the
 * second one is worth anything.
 */

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { abandonPreparationRunLocked } from "../../src/preparations/abandonment.js";
import { legFaultOutcome } from "../../src/preparations/attempts/cancel-delivery.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { attemptRequest, stagePreparation, type StagedPreparation } from "./attempt-fixture.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";

/** A fixed cancel nonce; the cancel record is authenticated, not free-form. */
const CANCEL_NONCE = "0".repeat(32);

const staged: StagedPreparation[] = [];
afterEach(async () => {
  await Promise.all(staged.splice(0).map(
    (run) => rm(run.root, { recursive: true, force: true }).catch(() => undefined)));
});

/** Stage a run whose required leg THROWS, and drive that attempt. */
async function faultedRun(): Promise<StagedPreparation> {
  const run = await stagePreparation();
  staged.push(run);
  const outcome = await executePhaseAttempt(attemptRequest(run, {
    leg: async () => { throw new Error("isolation tool unavailable"); },
  }));
  // The attempt reports a park, not a commit: an unknown-state leg is never a
  // durable success.
  expect(outcome.status).toBe("parked");
  return run;
}

/** The run as the durable store holds it — never an in-memory return value. */
async function readRun(run: StagedPreparation): Promise<Awaited<ReturnType<typeof readPreparationRun>>> {
  return readPreparationRun(run.root, run.binding);
}

/** Prove the parked run has a usable operator exit. */
async function expectAbandonable(run: StagedPreparation): Promise<void> {
  const abandoned = await abandonPreparationRunLocked(run.root, {
    binding: run.binding, actor: { id: "operator", surface: "cli" },
    at: new Date().toISOString(), confirmResidualState: true,
  });
  expect(abandoned.state).toBe("abandoned");
}

describe("a required leg's fault parks the run, recoverably", () => {
  it("leaves the RUN recovery-required, naming the leg fault — never an ownerless running run", async () => {
    const run = await faultedRun();
    const read = await readRun(run);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    // The whole point: the RUN is parked. Before the fix this read `running`.
    expect(read.run.state).toBe("recovery-required");
    // And no owner is left fencing a run nothing will advance.
    expect(read.run.executionOwner).toBeUndefined();
    // The park says WHY, so an operator can tell a missing tool from an
    // integrity fault instead of seeing one generic obligation. The run-level
    // code lives in the transition ledger rather than on the run object, so the
    // PHASE's own problem is what a reader sees here.
    const phase = read.run.phaseSummaries.find((entry) => entry.logicalPhaseId === "collect");
    expect(phase?.state).toBe("recovery-required");
    expect(phase?.problem, "the leg's own cause survives the park").toBe("leg-fault");
    // The RUN-level classification, read off the transition the park appended.
    // Without this a mutant mapping the reason back to the generic
    // `preparation-integrity-obligation` passes every other assertion here.
    const parked = read.run.transitions.filter((entry) => entry.type === "recovery-required").at(-1);
    expect(parked?.payload).toMatchObject({ kind: "problem", code: "preparation-leg-fault" });
  });

  it("carries the leg's problemDetail through the park, not just its code", async () => {
    // `legFaultOutcome` supplies no detail, so a thrown leg cannot witness this
    // field; a leg returning the outcome directly can. Without it, deleting
    // `problemDetail` from the park projector survives.
    const run = await stagePreparation();
    staged.push(run);
    const outcome = await executePhaseAttempt(attemptRequest(run, {
      leg: async () => ({
        phaseState: "recovery-required" as const, pendingEvidence: [], effects: [],
        invocationCount: 0, brokerRequestCount: 0, tokenCount: 0, costMicros: 0,
        problem: "leg-fault", problemDetail: "isolation tool llmwiki-no-such-tool is not installed",
      }),
    }));
    expect(outcome.status).toBe("parked");
    const read = await readRun(run);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    const phase = read.run.phaseSummaries.find((entry) => entry.logicalPhaseId === "collect");
    expect(phase?.problemDetail, "the sentence an operator reads survives")
      .toBe("isolation tool llmwiki-no-such-tool is not installed");
  });

  it("is ABANDONABLE from that state — the exit an operator actually has", async () => {
    const run = await faultedRun();
    // Abandon requires the RUN to be `recovery-required`; this is the assertion
    // that would have failed on the old ownerless-`running` shape, and it is
    // the one that makes the park a park rather than a wedge.
    await expectAbandonable(run);
    const read = await readRun(run);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    expect(read.run.state, "durably abandoned, not just returned").toBe("abandoned");
  });

  it("does NOT park when a cancellation was observed — that settlement owns the run", async () => {
    // THE BOUNDARY of this change. A cancelled attempt also settles an
    // unknown-state phase, but its own settlement runs immediately after the
    // commit and records `cancelled` on the run — which is what stops a sibling
    // phase finishing behind a delivered cancel. Parking here would preempt it
    // and replace `cancelled` with `recovery-required`, discarding the
    // operator's cancel. So the park is scoped to the no-cancellation path, and
    // this arm is what keeps a future widening honest.
    const run = await stagePreparation();
    staged.push(run);
    const previous = process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS;
    process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS = "50";
    try {
      let legStarted!: () => void;
      const started = new Promise<void>((resolve) => { legStarted = resolve; });
      const attempt = executePhaseAttempt(attemptRequest(run, {
        leg: () => { legStarted(); return new Promise<never>(() => {}); },
      }));
      await started;
      await writePreparationCancelLockFree(run.root, {
        workspaceId: run.binding.workspaceId, runId: run.binding.runId,
        requester: "op", at: "2026-07-22T00:00:00.000Z", nonce: CANCEL_NONCE,
      });
      // COMMITTED, not parked: the cancellation settlement, not this park, owns
      // what the run records next.
      expect(await attempt).toMatchObject({ status: "committed", phaseState: "recovery-required" });
      const read = await readRun(run);
      if (read.status !== "ok") throw new Error(`run ${read.status}`);
      expect(read.run.state, "the operator's cancel survives").toBe("cancelled");
    } finally {
      if (previous === undefined) delete process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS;
      else process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS = previous;
    }
  }, 30_000);

  it("RESIDUAL: a cancel not DELIVERED before the leg completed parks with the fault code", async () => {
    // The honest boundary of this change, pinned so nobody reads it as more.
    // A cancel that was never DELIVERED to this executor cannot be honoured
    // here: the discriminator is the delivered observation, deliberately not
    // the advisory file, because a `.cancel` is forgeable and retractable and
    // `parkedByCancellation` refuses to treat its presence as proof.
    //
    // The boundary is DELIVERY, not publication time: any valid cancel present
    // by the commit but undelivered before the leg completed lands here, which
    // is why this arm publishes from INSIDE the leg rather than after it.
    //
    // So this parks with the leg-fault code and that advisory is not consumed —
    // abandoning does not delete it either; a later recovery sweep collects it
    // as terminal residue. What must remain true — and is asserted — is that
    // the run is NOT stranded: it parks, and abandon still works.
    // Closing the gap by re-reading the advisory here was tried and rejected:
    // it races in BOTH directions, and a retraction between the two reads
    // skips the park and restores the ownerless-`running` strand.
    const run = await stagePreparation();
    staged.push(run);
    await executePhaseAttempt(attemptRequest(run, {
      leg: async () => {
        await writePreparationCancelLockFree(run.root, {
          workspaceId: run.binding.workspaceId, runId: run.binding.runId,
          requester: "op", at: "2026-07-22T00:00:00.000Z", nonce: CANCEL_NONCE,
        });
        throw new Error("isolation tool unavailable");
      },
    }));
    const read = await readRun(run);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    expect(read.run.state, "parked, never left ownerless-running").toBe("recovery-required");
    expect(read.run.executionOwner).toBeUndefined();
    // THE PROPERTY THAT MATTERS: the operator still has an exit.
    await expectAbandonable(run);
  }, 30_000);

  it("classifies the fault the same way the executor does", async () => {
    // The park's phase state comes from the shared classifier, so a change there
    // cannot silently diverge from what this suite pins.
    expect(legFaultOutcome(new Error("boom"))).toMatchObject({
      phaseState: "recovery-required", problem: "leg-fault",
    });
  });
});
