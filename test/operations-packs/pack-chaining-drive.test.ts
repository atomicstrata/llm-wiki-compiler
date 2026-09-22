/**
 * @file test/operations-packs/pack-chaining-drive.test.ts
 * @description G1 phase-output chaining, proven end to end on a two-phase autosci
 * action: an eligibility `select` filter over the candidate paper, then an
 * `intent` phase that reads the FILTERED item — a predecessor's committed output,
 * not the action input — and authors one paper page. Before G1 the runtime
 * refused any predecessor-output binding (`pack-phase-output-input-deferred`),
 * which made a chained handoff unreachable; here the intent phase resolves the
 * predecessor's items and the run reaches a Milestone A handoff.
 *
 * The eligibility case is the negative half: a candidate missing its `doi`
 * identity is filtered to nothing, the intent phase produces no draft, and the
 * materializer refuses — the run does NOT hand off. Together the two prove the
 * intent phase genuinely consumes phase 1's output rather than the action input.
 */

import { afterEach, describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import type { RunPreparationResultV1 } from "../../src/preparations/runner.js";
import { mixedTerminalPaperRequest } from "./compile-fixture.js";
import {
  compileBothSourcesAction, compileTwoPhasePaperAction, driveStagedRun, phaseStates, readPhaseOutput,
  resultReason, stageCompiledAction, stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

/** Stage and drive one two-phase paper action for the given input. */
async function drivePaper(
  input: { topic: string; doi?: string },
): Promise<{ run: StagedPackRunV1; result: RunPreparationResultV1 }> {
  const run = tracker.add(await stageCompiledAction(await compileTwoPhasePaperAction(input)));
  return { run, result: await driveStagedRun(run) };
}

const ELIGIBLE = { topic: "superconductivity", doi: "10.1/abc" } as const;

describe("G1: an intent phase reads a predecessor select phase's output", () => {
  it("drives the two-phase paper action to a handoff", async () => {
    const { result } = await drivePaper(ELIGIBLE);
    expect(result.status, resultReason(result)).toBe("handed-off");
  });

  it("EXECUTED both phases: the intent settled only by reading the select's output", async () => {
    const { run } = await drivePaper(ELIGIBLE);
    const read = await readPreparationRun(run.root, run.binding);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    const pick = read.run.phaseSummaries.find((entry) => entry.logicalPhaseId === "pick");
    const propose = read.run.phaseSummaries.find((entry) => entry.logicalPhaseId === "propose");
    expect(pick?.state).toBe("succeeded");
    expect(propose?.state).toBe("succeeded");
    expect(propose?.outputEvidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("creates exactly one problem-free Milestone A bundle", async () => {
    const { run, result } = await drivePaper(ELIGIBLE);
    expect(result.status, resultReason(result)).toBe("handed-off");
    const inventory = await scanOperationInventory(run.root);
    expect(inventory.problems).toHaveLength(0);
    expect(inventory.completeBundleIds.size).toBe(1);
  });

  it("the eligibility gate refuses: a candidate missing its doi is filtered out, so nothing hands off", async () => {
    // BOTH phases must SUCCEED for this negative to mean what it claims: the
    // filter ran (and excluded), and the chained intent phase genuinely read the
    // empty selection and published ZERO drafts. A broken chain would FAIL the
    // intent phase instead of succeeding with an empty draft set.
    const { run, result } = await drivePaper({ topic: "superconductivity" });
    expect(result.status).not.toBe("handed-off");
    const states = await phaseStates(run);
    expect(states.get("pick")).toBe("succeeded");
    expect(states.get("propose")).toBe("succeeded");
    expect((await readPhaseOutput(run, "propose") as { drafts: unknown }).drafts).toEqual([]);
  });

  it("a phase binding BOTH sources sees their union: the dedupe excludes the second arrival", async () => {
    // The union phase binds the action input AND pick's output — the same
    // candidate arrives once from each source, so its dedupe keeps one and must
    // record the other as a duplicate. An evidence set read from either source
    // alone has one item and excludes nothing. (Initial-vs-predecessor ORDER is
    // unobservable here: every current family passes the item through unchanged,
    // so the two arrivals are byte-identical.)
    const run = tracker.add(await stageCompiledAction(await compileBothSourcesAction(ELIGIBLE)));
    const result = await driveStagedRun(run);
    expect(result.status, resultReason(result)).toBe("handed-off");
    const published = await readPhaseOutput(run, "union") as { selection: unknown };
    expect(published.selection).toEqual({
      included: ["action-input"],
      excluded: [{ itemId: "action-input", reason: "duplicate-identity" }],
    });
  });

  it("a TERMINAL bound to both sources drafts ONCE when the same item arrives twice", async () => {
    // The candidate reaches the intent phase from the action input AND through
    // pick's passthrough — one identity, two arrivals. Intent collapses to one
    // draft (the materializer's planned Set applies the same rule), so the run
    // hands off instead of refusing over a self-collision.
    const run = tracker.add(await stageCompiledAction(await compilePackAction(mixedTerminalPaperRequest(ELIGIBLE))));
    const result = await driveStagedRun(run);
    expect(result.status, resultReason(result)).toBe("handed-off");
    const drafts = (await readPhaseOutput(run, "propose") as { drafts: unknown[] }).drafts;
    expect(drafts).toHaveLength(1);
  });
});
