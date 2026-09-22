/**
 * @file test/preparation-capacity-matrix-budget.test.ts
 * @description Exact cap-boundary coverage for the two run-budget dimensions an
 * operator can drive to their limit through the binary: the reserved control
 * headroom `PREPARATION_RUN_CONTROL_RESERVE_BYTES`
 * (`src/preparations/run-budget.ts:148`), reachable through `--allowance`, and
 * the non-reserved ordinary budget `MAX_PREPARATION_RUN_BYTES` minus that
 * reserve (`src/preparations/run-budget.ts:147`), reachable through the plan's
 * declared `maximumTransitions`.
 *
 * Both boundaries are DERIVED (see `ordinaryTransitionCeiling` and
 * `controlAllowanceCeiling`), because neither is a published constant: each is a
 * function of a canonical record width and the per-transition envelope charge.
 * The at-cap and over-cap halves pin the derivation from both sides — a
 * derivation that drifted by one would fail one half or the other.
 *
 * The allowance is passed explicitly on every invocation. Relying on the CLI's
 * private default would couple the derivation to a constant this file cannot
 * see, and a change to it would silently move the boundary being measured.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED, budgetInputFor, controlAllowanceCeiling, expectStoreUnchanged,
  ordinaryTransitionCeiling, planFor, projectWith, refusalReason, rewritePlan, stage,
  stagedRunId,
} from "./preparation-capacity-fixture.js";
import { projectPreparationRunBudget } from "../src/preparations/run-budget.js";
import {
  MAX_PREPARATION_RUN_BYTES, MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES,
  PREPARATION_RUN_CONTROL_RESERVE_BYTES,
} from "../src/preparations/constants.js";

/** The allowance every ordinary-budget case pins, well inside the reserve. */
const PINNED_ALLOWANCE = 16;

/** A plan document declaring exactly `transitions` ordinary transitions. */
function planWithTransitions(transitions: number): Record<string, unknown> {
  return planFor(DEFAULT_SEED, (plan) => {
    (plan.bounds as Record<string, number>).maximumTransitions = transitions;
  });
}

/** A project whose plan declares exactly `transitions` ordinary transitions. */
async function projectWithTransitions(suffix: string, transitions: number) {
  return projectWith(suffix, JSON.stringify(planWithTransitions(transitions)), JSON.stringify(DEFAULT_SEED));
}

describe("reserved control headroom, through the built binary", () => {
  it("stages at exactly the largest allowance the reserve holds", async () => {
    const documents = await projectWith(
      "capctl-at", JSON.stringify(planFor(DEFAULT_SEED)), JSON.stringify(DEFAULT_SEED));

    const staged = await stage(documents, ["--allowance", String(controlAllowanceCeiling())]);

    expect(stagedRunId(staged)).toMatch(/^prr_/u);
  });

  it("refuses one control transition over the reserve and stages nothing", async () => {
    // Staging once first is the fault setup that makes "unchanged" meaningful:
    // it mints the key epoch, so the store the refusal is measured against is a
    // real populated store rather than an empty directory.
    const documents = await projectWith(
      "capctl-over", JSON.stringify(planFor(DEFAULT_SEED)), JSON.stringify(DEFAULT_SEED));
    stagedRunId(await stage(documents, ["--allowance", String(controlAllowanceCeiling())]));

    const refused = await expectStoreUnchanged(documents.cwd, () =>
      stage(documents, ["--allowance", String(controlAllowanceCeiling() + 1)]));

    expect(refusalReason(refused))
      .toBe("staging refused: control transition allowance exceeds the 256 KiB control reserve");
  }, 60_000);
});

describe("non-reserved ordinary budget, through the built binary", () => {
  it("stages a plan declaring exactly the largest admissible transition count", async () => {
    const ceiling = ordinaryTransitionCeiling(planFor(DEFAULT_SEED), PINNED_ALLOWANCE);
    const documents = await projectWithTransitions("capord-at", ceiling);

    const staged = await stage(documents, ["--allowance", String(PINNED_ALLOWANCE)]);

    expect(stagedRunId(staged)).toMatch(/^prr_/u);
  }, 60_000);

  it("refuses one declared transition over the ordinary budget and stages nothing", async () => {
    const ceiling = ordinaryTransitionCeiling(planFor(DEFAULT_SEED), PINNED_ALLOWANCE);
    const documents = await projectWithTransitions("capord-over", ceiling);
    // Stage the at-ceiling plan first, then move ONE transition past it in the
    // same project: the refusal is measured against a populated store, and the
    // only thing that changed between admission and refusal is the boundary.
    stagedRunId(await stage(documents, ["--allowance", String(PINNED_ALLOWANCE)]));
    await rewritePlan(documents, JSON.stringify(planWithTransitions(ceiling + 1)));

    const refused = await expectStoreUnchanged(documents.cwd, () =>
      stage(documents, ["--allowance", String(PINNED_ALLOWANCE)]));

    expect(refusalReason(refused))
      .toBe("staging refused: projected ordinary run consumes reserved control headroom");
  }, 60_000);

  it("keeps the projected ordinary bytes inside the budget at exactly the ceiling", async () => {
    // The CLI cases prove admission; this proves WHY the ceiling is where it is,
    // so an at-cap stage that started passing for an unrelated reason would not
    // read as confirmation of the boundary.
    const ceiling = ordinaryTransitionCeiling(planFor(DEFAULT_SEED), PINNED_ALLOWANCE);
    const budget = projectPreparationRunBudget(budgetInputFor(planWithTransitions(ceiling), PINNED_ALLOWANCE));

    const limit = MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES;
    expect(budget.projectedOrdinaryBytes).toBeLessThanOrEqual(limit);
    // Within one transition of the limit: proof the ceiling is the LARGEST
    // admissible count and not merely an admissible one.
    expect(budget.projectedOrdinaryBytes).toBeGreaterThan(limit - (MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES + 1));
  });
});
