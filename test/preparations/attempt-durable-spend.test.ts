/**
 * @file test/preparations/attempt-durable-spend.test.ts
 * @description Durable per-attempt token and cost spend on the phase summary.
 * The metered dimensions used to live only in the leg outcome, so the cost a
 * retry preview must report as already spent died with the process that observed
 * it. These suites drive REAL attempts through `executePhaseAttempt` and read the
 * spend back off the AUTHENTICATED run record, and they pin the honest
 * representation of absence: an unmetered dimension is omitted, never persisted
 * as a zero that would report a billable attempt as free.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { durableRetryCostPreview } from "../../src/preparations/attempts/retry.js";
import {
  attemptRequest, driftingResolver, phaseInstanceIdFor, providerAuthority, stagePreparation,
  succeededLeg, wideBounds, type StagedPreparation,
} from "./attempt-fixture.js";
import { readRun } from "./cancel-settlement-fixture.js";
import type { AttemptLegOutcomeV1 } from "../../src/preparations/attempts/types.js";
import type { PhaseSummaryV1 } from "../../src/preparations/run-types.js";

/** A provider pin the seal never bound: re-resolving it at commit is real drift. */
const DRIFTED_PIN = parseSha256Digest(`sha256:${"b".repeat(64)}`);

/** A leg reporting the given host-observed usage; everything else is the default. */
function legReporting(usage: Partial<AttemptLegOutcomeV1>) {
  return async () => ({ ...succeededLeg(), ...usage }) as AttemptLegOutcomeV1;
}

/** The retry cost preview fed from the run's own durable phase summaries. */
async function collectPreview(staged: StagedPreparation) {
  const run = await readRun(staged);
  return durableRetryCostPreview(run.phaseSummaries, phaseInstanceIdFor(staged.binding, "collect"), wideBounds());
}

/** The durable summary of the fixture's `collect` phase on the authenticated run. */
async function collectSummary(staged: StagedPreparation): Promise<PhaseSummaryV1> {
  const phaseInstanceId = phaseInstanceIdFor(staged.binding, "collect");
  const summary = (await readRun(staged)).phaseSummaries.find((item) => item.phaseInstanceId === phaseInstanceId);
  if (summary === undefined) throw new Error("the attempt must have projected a phase summary");
  return summary;
}

describe("durable per-attempt spend", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("persists the metered token and cost spend of a committed attempt", async () => {
    staged = await stagePreparation();
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: legReporting({ tokenCount: 7, costMicros: 3 }) }));
    expect(outcome).toMatchObject({ status: "committed" });
    expect(await collectSummary(staged)).toMatchObject({ tokenCount: 7, costMicros: 3 });
  });

  it("omits an unobserved dimension rather than persisting a fabricated zero", async () => {
    staged = await stagePreparation();
    const leg = legReporting({ phaseState: "failed", tokenCount: "unobserved", costMicros: "unobserved" });
    await executePhaseAttempt(attemptRequest(staged, { leg }));
    const summary = await collectSummary(staged);
    expect(summary.state).toBe("failed");
    expect(Object.hasOwn(summary, "tokenCount")).toBe(false);
    expect(Object.hasOwn(summary, "costMicros")).toBe(false);
  });

  it("persists the spend a durably parked attempt had already incurred", async () => {
    staged = await stagePreparation();
    const authorityResolver = driftingResolver(providerAuthority(), providerAuthority({ providerPinDigest: DRIFTED_PIN }));
    const leg = legReporting({ tokenCount: 5, costMicros: 9 });
    const outcome = await executePhaseAttempt(attemptRequest(staged, { authorityResolver, leg }));
    expect(outcome).toMatchObject({ status: "parked", reason: "authority-drift" });
    expect(await collectSummary(staged)).toMatchObject({ state: "recovery-required", tokenCount: 5, costMicros: 9 });
  });

  it("feeds the retry cost preview from the durable record", async () => {
    staged = await stagePreparation();
    await executePhaseAttempt(attemptRequest(staged, { leg: legReporting({ tokenCount: 7, costMicros: 3 }) }));
    const preview = await collectPreview(staged);
    expect(preview.alreadySpentCostMicros).toBe(3);
  });

  it("keeps an unmetered prior attempt unobserved in the preview, never free", async () => {
    staged = await stagePreparation();
    const leg = legReporting({ phaseState: "failed", tokenCount: "unobserved", costMicros: "unobserved" });
    await executePhaseAttempt(attemptRequest(staged, { leg }));
    const preview = await collectPreview(staged);
    expect(preview.alreadySpentCostMicros).toBe("unobserved");
  });

  it("reports a structural zero for a phase that was never attempted", async () => {
    staged = await stagePreparation();
    const preview = durableRetryCostPreview([], phaseInstanceIdFor(staged.binding, "collect"), wideBounds());
    expect(preview.alreadySpentCostMicros).toBe(0);
  });
});

// The sealed ceiling is an AUTHORIZATION, not a success-path formality. A leg
// that settles any other way still had to stay inside it, and the loader cannot
// re-check that later: `parsePhaseSummary` never sees the plan, so a figure above
// the ceiling would reach a cost preview as fact if the commit path let it land.
describe("spend above the sealed ceiling", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("parks a non-success outcome whose measured cost exceeds the sealed ceiling", async () => {
    staged = await stagePreparation();
    const leg = legReporting({ phaseState: "failed", costMicros: Number.MAX_SAFE_INTEGER });
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg }));
    expect(outcome).toMatchObject({ status: "parked", reason: "cost-exceed-sealed-bound" });
  });

  it("never lands the over-ceiling figure in the signed record", async () => {
    staged = await stagePreparation();
    const leg = legReporting({ phaseState: "failed", tokenCount: Number.MAX_SAFE_INTEGER, costMicros: Number.MAX_SAFE_INTEGER });
    await executePhaseAttempt(attemptRequest(staged, { leg }));
    const summary = await collectSummary(staged);
    expect(Object.hasOwn(summary, "tokenCount")).toBe(false);
    expect(Object.hasOwn(summary, "costMicros")).toBe(false);
  });

  it("reports the unadmissible spend as unobserved, never as free", async () => {
    staged = await stagePreparation();
    const leg = legReporting({ phaseState: "failed", costMicros: Number.MAX_SAFE_INTEGER });
    await executePhaseAttempt(attemptRequest(staged, { leg }));
    const preview = await collectPreview(staged);
    expect(preview.alreadySpentCostMicros).toBe("unobserved");
  });

  it("still commits a non-success outcome whose measured spend fits", async () => {
    staged = await stagePreparation();
    const leg = legReporting({ phaseState: "failed", tokenCount: 4, costMicros: 2 });
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg }));
    expect(outcome).toMatchObject({ status: "committed", phaseState: "failed" });
    expect(await collectSummary(staged)).toMatchObject({ tokenCount: 4, costMicros: 2 });
  });
});
