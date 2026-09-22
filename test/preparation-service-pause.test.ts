/**
 * @file test/preparation-service-pause.test.ts
 * @description The `pause` operation — the first production writer of `paused`.
 *
 * THE CASES ARE ORGANISED BY WHAT DECIDES THE ANSWER, not by outcome, because
 * every refusal here returns the same shape and a suite grouped by outcome cannot
 * show which precondition produced it. The three in-flight cases are the point:
 * they are the same refusal with three different remedies, and the remedy is the
 * only observable difference between an owner that is confirmed running, one that
 * is provably gone, and one this host cannot identify at all.
 *
 * `awaiting-gate` IS NOT PAUSABLE, and the block below that once said otherwise
 * now asserts the refusal. It is worth reading that block for what it used to
 * claim: `awaiting-gate` was "the other pausable state", its end-to-end pause was
 * called unwitnessable, and a derived-set case was offered as the only thing that
 * could pin it. All three were true of a build in which the pause/resume pair
 * could walk a run from `awaiting-gate` to `running` past its own gate decision.
 *
 * THE STATE IS STILL WRITTEN BY NOTHING IN PRODUCTION, and that half of the old
 * paragraph survives — no appender targets it and `gate` records its decision
 * without moving the run — so the fixture builds it through the substrate's own
 * `gate-blocked` transition. What changed is what that unreachability licensed:
 * it was used to argue no case was owed, when what it actually meant was that a
 * latent bypass would ship unwitnessed and arm itself the day a writer appeared.
 * Absence of a writer is a reason to build the fixture, not a reason to skip it.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { PAUSABLE_RUN_STATE, PAUSE_EDGE_EXISTS } from "../src/preparations/service-pause.js";
import { LEGAL_EDGES } from "../src/preparations/run-validation.js";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationServiceV1 } from "../src/preparations/service.js";
import {
  driveAwaitingGate, driveCheckpointed, driveRunning, readRun, stagedProject,
} from "./preparation-recovery-fixture.js";
import type { RunningRunFixture } from "./preparation-recovery-fixture.js";

let fixture: RunningRunFixture;
let service: PreparationServiceV1;

beforeEach(async () => {
  fixture = await stagedProject("pause");
  service = createPreparationService({
    root: fixture.root, surface: "cli",
    principals: { principalFor: () => ({ id: "operator", surface: "cli", grants: ["preparation.run"] }) },
  });
});
afterEach(async () => { await fixture.cleanup(); });

describe("pause — the state it may be entered from", () => {
  it("holds a run that reached a durable safe checkpoint", async () => {
    await driveCheckpointed(fixture);
    const outcome = await service.pause({ runId: fixture.binding.runId });
    expect(outcome).toEqual({ status: "paused", runId: fixture.binding.runId, transition: "appended" });
    // THE DURABLE READ, not the DTO: a result asserting a pause that was never
    // appended is exactly the failure this reads past.
    const run = await readRun(fixture);
    expect(run.state).toBe("paused");
    expect(run.executionOwner).toBeUndefined();
  });

  it("reports an already-paused run as success without appending twice", async () => {
    await driveCheckpointed(fixture);
    await service.pause({ runId: fixture.binding.runId });
    const before = (await readRun(fixture)).transitions.length;
    const outcome = await service.pause({ runId: fixture.binding.runId });
    expect(outcome).toEqual({
      status: "paused", runId: fixture.binding.runId, transition: "already-paused",
    });
    // IDEMPOTENT MEANS NOTHING WAS WRITTEN, and only the transition count says so:
    // `paused` has no self-edge, so a second append would have been refused by the
    // validator rather than duplicated — and the operator would have been told
    // their pause failed over a run that is paused.
    expect((await readRun(fixture)).transitions.length).toBe(before);
  });

  it("refuses a run that has not started", async () => {
    const outcome = await service.pause({ runId: fixture.binding.runId });
    // THE MESSAGE NARROWED WITH THE DOMAIN. It previously read "running or
    // awaiting a gate", which described the defect accurately — the domain did
    // admit both. Re-pointed, not relaxed: still an exact-equality assertion on
    // the whole result, and it now names the one state that is admitted.
    expect(outcome).toEqual({
      status: "refused",
      reason: "only a running run can be paused; this run is planned",
    });
    expect((await readRun(fixture)).state).toBe("planned");
  });

  it("names terminality rather than pausability for a finished run", async () => {
    // A terminal run fails BOTH preconditions, so the order is what is observed:
    // "already terminal" tells the operator what happened, "cannot be paused"
    // tells them about a rule.
    await service.fail({ runId: fixture.binding.runId });
    const outcome = await service.pause({ runId: fixture.binding.runId });
    expect(outcome).toEqual({
      status: "refused", reason: "this run is already terminal (failed); there is nothing to pause",
    });
  });
});

describe("pause — an attempt in flight refuses, and the remedy depends on the owner", () => {
  /** Drive the run to `running` under `owner`, then attempt the pause. */
  async function pauseUnder(owner: "identified" | "stranded" | "live"): Promise<string> {
    await driveRunning(fixture, owner);
    const outcome = await service.pause({ runId: fixture.binding.runId });
    expect(outcome.status).toBe("refused");
    // NOTHING MOVED, asserted on every arm: a refusal reported after a commit
    // looks identical from the result alone.
    const run = await readRun(fixture);
    expect(run.state).toBe("running");
    expect(run.executionOwner).toBeDefined();
    return outcome.status === "refused" ? outcome.reason : "";
  }

  it("tells an operator with a CONFIRMED live executor to wait or cancel", async () => {
    const reason = await pauseUnder("identified");
    expect(reason).toContain("an attempt is still running on this run");
    expect(reason).toContain("cancel the run to stop it now");
  });

  it("tells an operator with a PROVABLY GONE executor to recover first", async () => {
    const reason = await pauseUnder("stranded");
    expect(reason).toContain("the process that was running this run's attempt is gone");
    expect(reason).toContain("recover the run first");
  });

  it("tells an operator with an UNIDENTIFIABLE executor that recovery will refuse too", async () => {
    // THE STRAND, AND THE ONLY CASE WHOSE MESSAGE IS NOT A RETRY. This owner
    // records a pid and no start time — the shape the current build mints
    // whenever the host cannot read its own start time — so the process exists
    // and nothing can say which process it is. Recovery reads unidentifiable as
    // live by the same fail-safe rule, so pointing the operator at it would send
    // them at a verb that also refuses.
    const reason = await pauseUnder("live");
    expect(reason).toContain("cannot determine whether its process is still alive");
    expect(reason).toContain("neither pause nor recovery will act on it");
    expect(reason).not.toContain("recover the run first");
  });
});

describe("pause — the domain is a singleton, cross-checked against the edge table", () => {
  // THIS BLOCK PREVIOUSLY ASSERTED THE DEFECT. It pinned the pausable set as
  // exactly the states whose edges admit `paused` — deriving it, and asserting
  // the derivation equalled `["awaiting-gate", "running"]`. That derivation is
  // what made the pause/resume pair a route from `awaiting-gate` to `running`:
  // both legs are legal edges, their composition is not, and nothing recorded
  // the origin in between. The cases are re-pointed rather than deleted, because
  // the state they named is still the interesting one — it is now the refusal.

  it("is exactly `running`, and the substrate still admits the edge it needs", () => {
    expect(PAUSABLE_RUN_STATE).toBe("running");
    // CONSULTED, NOT COPIED. A hand-written domain that cannot be checked against
    // the validator is the drift the old derivation was avoiding, and that
    // concern was legitimate — this keeps it without inheriting the widening.
    expect(PAUSE_EDGE_EXISTS).toBe(true);
    expect(LEGAL_EDGES[PAUSABLE_RUN_STATE].has("paused")).toBe(true);
  });

  it("does NOT admit every state whose edges reach paused", () => {
    // THE DEFECT, NAMED AS A NON-PROPERTY. `awaiting-gate` legally reaches
    // `paused`, so an edge-derived domain includes it; the domain must not.
    // Asserting the gap rather than the singleton alone is what keeps a future
    // re-derivation from passing.
    const edgeDerived = (Object.keys(LEGAL_EDGES) as (keyof typeof LEGAL_EDGES)[])
      .filter((state) => LEGAL_EDGES[state].has("paused"));
    expect(edgeDerived).toContain("awaiting-gate");
    expect(edgeDerived.filter((state) => state !== PAUSABLE_RUN_STATE)).toEqual(["awaiting-gate"]);
  });

  // THE TWO CASES ABOVE PIN THE CONSTANT; THIS ONE PINS THE BEHAVIOUR, and a
  // mutant showed the pair is not redundant: widening the CHECK while leaving
  // `PAUSABLE_RUN_STATE` alone compiles, keeps both assertions above green, and
  // restores the bypass. The declared domain and the enforced one are different
  // facts, so each needs its own case.
  it("refuses an awaiting-gate run and points at the verb that releases it", async () => {
    await driveAwaitingGate(fixture);
    const outcome = await service.pause({ runId: fixture.binding.runId });
    expect(outcome).toMatchObject({ status: "refused" });
    expect((outcome as { reason: string }).reason).toContain("gate");
    // THE STATE, NOT ONLY THE REFUSAL: a refusal that already appended satisfies
    // the status check and is exactly the thing being caught.
    expect((await readRun(fixture)).state).toBe("awaiting-gate");
  });
});
