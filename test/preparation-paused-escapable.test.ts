/**
 * @file test/preparation-paused-escapable.test.ts
 * @description The guarantee `pause` was refused review for lacking, stated as a
 * property and tested as one:
 *
 *   **A paused run is escapable by a principal holding `preparation.run`.**
 *
 * NOT A COMMAND COUNT. The rejected version of this guarantee was "operator-
 * completable without diagnosis in two shipped commands", and it was accepted for
 * a round because a count LOOKS like a bound. It hides the authority the way a
 * status hides a commit: the exits existed and were short, and every one of them
 * cost a token the pausing principal need not hold — `preparation.cancel`,
 * `preparation.recovery`, or the destructive `preparation.quarantine`. So the
 * guarantee is written with the grant in it, and the test HOLDS ONLY THAT GRANT.
 *
 * ON THE SDK SURFACE, because that is the only place the claim has content. A
 * `cli` principal holds the entire local-operator grant set by transport, so the
 * same journey run through the CLI would pass with the grant check deleted
 * outright. The stranding principal is always the LEAST-PRIVILEGED one who can
 * enter the state, and on this surface that principal is representable.
 *
 * THE STATE IS ASSERTED BEFORE THE RETURN VALUE, in every case. A verb reporting
 * `resumed` over a run still sitting at `paused` is the false-success shape this
 * program has paid for repeatedly, and reading the durable record first is what
 * makes the mutation legible: with the exit taken away, these cases go red
 * SHOWING THE RUN STILL PAUSED rather than showing a missing method.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import { expectNoRecoveryAuthority } from "./preparation-sdk-fixture.js";
import type { PreparationGrant } from "../src/preparations/service.js";
import { RESUMABLE_RUN_STATE, RESUME_EDGE_EXISTS } from "../src/preparations/service-resume.js";
import { preparationRunWriteBudgetClass } from "../src/preparations/run-budget.js";
import {
  driveAwaitingGate, driveCheckpointed, readRun, stagedProject,
} from "./preparation-recovery-fixture.js";
import type { RunningRunFixture } from "./preparation-recovery-fixture.js";

/**
 * EXACTLY THE TOKEN `pause` COSTS, and deliberately nothing else. Adding any
 * other grant to this list would make the suite pass for a build in which the
 * exit is gated behind that grant — which is the defect, not the fix.
 */
const PAUSE_ONLY_GRANTS: readonly PreparationGrant[] = ["preparation.run"];

let fixture: RunningRunFixture;

/** The SDK an embedder holding only the pause grant would construct. */
function pausingPrincipal() {
  return createWiki({
    root: fixture.root,
    preparation: { id: "sdk-embedder", grants: PAUSE_ONLY_GRANTS },
  });
}

/** The run's durable state, read back from disk rather than from a return value. */
async function durableState(): Promise<string> {
  return (await readRun(fixture)).state;
}

beforeEach(async () => {
  fixture = await stagedProject("escapable");
  await driveCheckpointed(fixture);
});
afterEach(async () => { await fixture.cleanup(); });

describe("a paused run is escapable by a principal holding preparation.run", () => {
  it("pauses and resumes with that grant and no other", async () => {
    const wiki = pausingPrincipal();
    const runId = fixture.binding.runId;

    expect(await wiki.pausePreparation(runId)).toMatchObject({ status: "paused" });
    expect(await durableState()).toBe("paused");

    const resumed = await wiki.resumePreparation(runId);

    // THE WORLD FIRST, THE REPORT SECOND. If the exit stops working, this is the
    // line that fails, and it fails saying `paused`.
    expect(await durableState()).toBe("running");
    expect(resumed).toMatchObject({ status: "resumed", runId, transition: "appended" });
  });

  it("needs no cancel, recovery or quarantine grant to get out", async () => {
    // THE NEGATIVE HALF OF THE SAME PROPERTY. The build could satisfy the case
    // above by ALSO accepting one of these tokens; that would still leave the
    // guarantee true. What must not happen is the exit REQUIRING one, which the
    // grant list this suite holds already forbids — so what this case adds is the
    // evidence that the principal genuinely lacks them.
    const wiki = pausingPrincipal();
    await expectNoRecoveryAuthority(wiki, fixture.binding.runId);

    // And the run is STILL reachable by its own token despite both refusals.
    await wiki.pausePreparation(fixture.binding.runId);
    await wiki.resumePreparation(fixture.binding.runId);
    expect(await durableState()).toBe("running");
  });

  it("is idempotent on retry, so a lost connection cannot strand it either", async () => {
    const wiki = pausingPrincipal();
    const runId = fixture.binding.runId;
    await wiki.pausePreparation(runId);
    await wiki.resumePreparation(runId);
    // The retry an operator makes when the first answer never arrived.
    expect(await wiki.resumePreparation(runId))
      .toMatchObject({ status: "resumed", transition: "already-running" });
    expect(await durableState()).toBe("running");
  });
});

describe("the edge the exit depends on", () => {
  it("is the one the substrate admits, not one this operation assumes", () => {
    // THE CROSS-CHECK, asserted rather than trusted. `resume`'s domain is a
    // semantic singleton — the state `pause` writes — and cannot be derived from
    // the edge table without also admitting `awaiting-gate`, which would make
    // this verb a way past a gate. So the table is checked instead of copied.
    expect(RESUMABLE_RUN_STATE).toBe("paused");
    expect(RESUME_EDGE_EXISTS).toBe(true);
  });
});

describe("the pause/resume pair shares a write-budget lane", () => {
  it("classifies resumed into the control reserve, exactly as paused is", () => {
    // A STRAND BUILT FROM TWO CORRECT-LOOKING HALVES. `paused` draws on the
    // reserved control headroom; `resumed` drew on the ordinary lane, which is
    // refused once a run's record passes `MAX - RESERVE`. So a run whose record
    // had grown into the reserve zone could be held and then not released, and the
    // only exits left were the destructive and terminal ones this whole guarantee
    // exists to avoid. Neither half looks wrong alone.
    expect(preparationRunWriteBudgetClass("resumed")).toBe("control");
    // THE PAIR, not the member — this is the invariant, and asserting the pair is
    // what keeps a future edit from moving one half without the other.
    expect(preparationRunWriteBudgetClass("resumed"))
      .toBe(preparationRunWriteBudgetClass("paused"));
  });

  // WHAT THIS DOES NOT WITNESS, stated rather than implied by a green: no case
  // here drives a run's record into the reserve zone and resumes it end to end.
  // That needs a multi-megabyte durable record, and the assertion above is over
  // the classification that ADMITS the write rather than over a proxy for it —
  // `assertPreparationRunWriteBudget` reads exactly this class. The gap is the
  // journey, not the rule.
});

describe("the pair cannot walk a run past a gate it is waiting on", () => {
  it("refuses to pause an awaiting-gate run, and leaves it awaiting-gate", async () => {
    // THE BYPASS, AS A SEQUENCE. Neither transition is illegal on its own —
    // `awaiting-gate -> paused` and `paused -> running` are both in the edge
    // table. Their COMPOSITION is the edge the table does not have:
    // `awaiting-gate -> running`, reached by an embedder holding nothing but
    // `preparation.run`, with no gate decision recorded anywhere.
    //
    // `pause` erased the origin — its transition carries `{ kind: "none" }` —
    // and `resume` always restores `running`, so by the time resume ran there
    // was nothing left to say the run had been waiting on a decision.
    //
    // THE ASSERTION IS THE STATE, NOT THE REFUSAL. A refusal that had already
    // appended would satisfy a status check perfectly, so the durable read is
    // the half that matters.
    await driveAwaitingGate(fixture);
    const wiki = pausingPrincipal();
    const paused = await wiki.pausePreparation(fixture.binding.runId);
    expect(paused).toMatchObject({ status: "refused" });
    expect(await durableState()).toBe("awaiting-gate");
  });

  it("leaves no route from awaiting-gate to running through the pair", async () => {
    // THE WHOLE SEQUENCE, RUN ANYWAY. Asserting the pause refusal alone would
    // stop one step short of the property that matters: what must be true is
    // that the run is still waiting on its decision after BOTH calls, however
    // each one answered.
    await driveAwaitingGate(fixture);
    const wiki = pausingPrincipal();
    await wiki.pausePreparation(fixture.binding.runId);
    await wiki.resumePreparation(fixture.binding.runId);
    expect(await durableState()).toBe("awaiting-gate");
  });

  it("still pauses a genuinely checkpointed run, so the fix did not close the verb", async () => {
    // THE GREEN HALF. Narrowing a domain is the easiest fix to overshoot, and a
    // suite of refusals passes perfectly against a verb that refuses everything.
    await driveCheckpointed(fixture);
    const wiki = pausingPrincipal();
    expect(await wiki.pausePreparation(fixture.binding.runId)).toMatchObject({ status: "paused" });
    expect(await durableState()).toBe("paused");
  });
});
