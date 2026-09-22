/**
 * @file test/preparation-cancel-recovery-authority.test.ts
 * @description Authority and boundary-input capture for `cancel` and
 * `recovery`, tested PER OPERATION.
 *
 * WHY PER OPERATION AND NOT ONCE. The rule this program arrived at the hard way:
 * a guarantee living in ONE shared body has no per-operation variance a mutant
 * can exploit, but a guarantee with its OWN call site per operation needs its own
 * test per operation. The grant charge is a per-operation entry in the service's
 * grant table, and the boundary-input capture is a per-operation line in each
 * operation module — so both get a case here for each of the two new verbs. Four
 * separate blockers in this program came from exactly the missing sibling.
 *
 * EVERY TEST RUNS ON THE `sdk` SURFACE, because that is the only surface where a
 * grant check has content: `effectivePreparationGrants` unions the whole
 * local-operator set into any `cli` principal, so the same check cannot fail
 * there and a green CLI test is not evidence of authorization.
 *
 * AND EACH REFUSAL IS PAIRED WITH A DURABLE RE-READ. A refusal that threw after
 * committing satisfies the rejection alone; the second assertion is what makes
 * the pair discriminating.
 */

import { describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationPrincipal } from "../src/preparations/service.js";
import { readPreparationCancel } from "../src/preparations/cancellation.js";
import {
  CANCEL_RECOVERY_GRANTS, countingRunIdRequest, driveRunning, expectStillRunningWithOwner,
  readRun, serviceOn, stageRunIn, stagedProject, strandedRun, type RunningRunFixture,
} from "./preparation-recovery-fixture.js";

/** Whether any advisory cancellation record exists for this run. */
async function cancelRequested(fixture: RunningRunFixture): Promise<boolean> {
  const read = await readPreparationCancel(
    fixture.root, fixture.binding.workspaceId, fixture.binding.runId);
  return read.status === "present";
}

/** A project holding two `planned` runs, so a substitution is observable. */
async function twoRuns(prefix: string): Promise<{ first: RunningRunFixture; second: RunningRunFixture }> {
  const first = await stagedProject(prefix);
  return { first, second: await stageRunIn(first.root) };
}

describe("each operation charges its own grant", () => {
  it("REFUSES cancel without `preparation.cancel`, and publishes nothing", async () => {
    const fixture = await stagedProject("authcancelgrant");
    try {
      // The RECOVERY grant only: a neighbouring token must not pay for this one.
      const service = serviceOn(fixture.root, "sdk", ["preparation.recovery"]);
      await expect(service.cancel({ runId: fixture.binding.runId }))
        .rejects.toMatchObject({ code: "missing-grant" });
      expect(await cancelRequested(fixture)).toBe(false);
    } finally { await fixture.cleanup(); }
  });

  it("REFUSES recovery without `preparation.recovery`, and parks nothing", async () => {
    const fixture = await strandedRun("authrecgrant");
    try {
      const service = serviceOn(fixture.root, "sdk", ["preparation.cancel"]);
      await expect(service.recovery({ runId: fixture.binding.runId }))
        .rejects.toMatchObject({ code: "missing-grant" });
      await expectStillRunningWithOwner(fixture);
    } finally { await fixture.cleanup(); }
  });

  it("REFUSES a resolver that forges `surface: \"cli\"` on an sdk service", async () => {
    // The forged-surface door matters MOST for this family: a `cli` principal
    // is handed `preparation.cancel` and `preparation.recovery` by transport, so
    // a caller who could set the surface would hold both for free.
    const fixture = await stagedProject("authforged");
    try {
      const service = createPreparationService({
        root: fixture.root, surface: "sdk",
        principals: {
          principalFor: () => ({ id: "forger", surface: "cli", grants: [] } as PreparationPrincipal),
        },
      });
      await expect(service.cancel({ runId: fixture.binding.runId }))
        .rejects.toMatchObject({ code: "invalid-principal" });
      expect(await cancelRequested(fixture)).toBe(false);
    } finally { await fixture.cleanup(); }
  });
});

describe("cancel captures its request before the first await", () => {
  it("publishes against the run the caller NAMED, not one substituted after", async () => {
    const { first, second } = await twoRuns("capcanceltarget");
    try {
      const request = { runId: first.binding.runId };
      const pending = serviceOn(first.root, "sdk", CANCEL_RECOVERY_GRANTS).cancel(request);
      // Synchronously after the call returns, before any await resolves.
      request.runId = second.binding.runId;

      expect(await pending).toMatchObject({ status: "requested", runId: first.binding.runId });
      expect(await cancelRequested(first)).toBe(true);
      // The load-bearing half: a retargeted request shows up as an advisory on a
      // run the caller never named.
      expect(await cancelRequested(second)).toBe(false);
    } finally { await first.cleanup(); }
  });

  // WAS "reads the field ONCE". One read was the strongest property available
  // while the prologue read was a plain `[[Get]]`: the getter still RAN, and the
  // operation still wrote an advisory on whatever it returned. The descriptor
  // read makes the second answer unreachable by never invoking the accessor, so
  // the count this pins is ZERO — a strictly stronger claim than the one it
  // replaces, and the reason the case is rewritten rather than deleted.
  it("REFUSES a two-answer run id without invoking it, and publishes nothing", async () => {
    const { first, second } = await twoRuns("capcancelsplit");
    try {
      const probe = countingRunIdRequest(first, second);

      const result = await serviceOn(first.root, "sdk", CANCEL_RECOVERY_GRANTS).cancel(probe.request);

      expect(probe.reads()).toBe(0);
      expect(result).toMatchObject({ status: "refused" });
      // Both halves: a refusal returned AFTER a write is not a refusal, and the
      // run the second answer names must be as untouched as the first.
      expect(await cancelRequested(first)).toBe(false);
      expect(await cancelRequested(second)).toBe(false);
    } finally { await first.cleanup(); }
  });
});

describe("recovery captures its request before the first await", () => {
  it("parks the run the caller NAMED, not one substituted after", async () => {
    const { first, second } = await twoRuns("caprectarget");
    try {
      await driveRunning(first, "stranded");
      await driveRunning(second, "stranded");
      const request = { runId: first.binding.runId };
      const pending = serviceOn(first.root, "sdk", CANCEL_RECOVERY_GRANTS).recovery(request);
      request.runId = second.binding.runId;

      expect(await pending).toMatchObject({ status: "parked", runId: first.binding.runId });
      expect((await readRun(first)).state).toBe("recovery-required");
      // The other run must be exactly where it was.
      expect((await readRun(second)).state).toBe("running");
    } finally { await first.cleanup(); }
  });

  // WAS "reads the field ONCE" — see the sibling case above for why the pinned
  // count is now zero rather than one.
  it("REFUSES a two-answer run id without invoking it, and parks nothing", async () => {
    const { first, second } = await twoRuns("caprecsplit");
    try {
      await driveRunning(first, "stranded");
      await driveRunning(second, "stranded");
      const probe = countingRunIdRequest(first, second);

      const result = await serviceOn(first.root, "sdk", CANCEL_RECOVERY_GRANTS).recovery(probe.request);

      expect(probe.reads()).toBe(0);
      expect(result).toMatchObject({ status: "refused" });
      expect((await readRun(first)).state).toBe("running");
      expect((await readRun(second)).state).toBe("running");
    } finally { await first.cleanup(); }
  });
});
