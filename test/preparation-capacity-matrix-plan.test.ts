/**
 * @file test/preparation-capacity-matrix-plan.test.ts
 * @description Exact cap-boundary coverage for the three DOCUMENT bounds a
 * normalized preparation plan is loaded under — `MAX_PLAN_BYTES`,
 * `MAX_PLAN_JSON_DEPTH` (`src/preparations/plan-parse.ts:58`, enforced by
 * `parseBoundedUniqueJson`) and `MAX_LOGICAL_PHASES_PER_PLAN`
 * (`src/preparations/plan-parse.ts:72`) — each at exactly its limit and one unit
 * over.
 *
 * SUBPROCESS LEVEL, because all three are operator-reachable: the plan document
 * and the `--seed` document are the only two things `preparation stage` takes
 * from an operator, and the seed is parsed through the SAME bounded reader with
 * the SAME two constants (`src/preparations/service-stage.ts`). The depth
 * cap is exercised through the seed because a plan's own nesting is fixed by its
 * closed schema — the seed is the one document whose shape an operator chooses.
 *
 * Every over-cap case also asserts the store is byte-for-byte unchanged. These
 * three refuse while loading the documents, before the project lock is taken, so
 * "unchanged" here means genuinely untouched.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED, chainPlan, expectStoreUnchanged, nested, padTo, planFor,
  projectWith, refusalReason, stage, stagedRunId,
} from "./preparation-capacity-fixture.js";
import {
  MAX_LOGICAL_PHASES_PER_PLAN, MAX_PLAN_BYTES, MAX_PLAN_JSON_DEPTH,
} from "../src/preparations/constants.js";

/** The base plan document, serialized, for the byte-cap pair. */
function baseDocument(): string {
  return JSON.stringify(planFor(DEFAULT_SEED));
}

/** Stage the given documents in a fresh project, expecting a refusal and no writes. */
async function refusedIn(suffix: string, planText: string, seedText: string): Promise<string> {
  const documents = await projectWith(suffix, planText, seedText);
  return refusalReason(await expectStoreUnchanged(documents.cwd, () => stage(documents)));
}

describe("plan document byte cap", () => {
  it("stages a document of exactly MAX_PLAN_BYTES", async () => {
    // Trailing whitespace is the one padding a closed schema tolerates: the
    // shape scanner skips it and then requires end-of-input, so the document is
    // exactly at the cap while still parsing to the same plan.
    const documents = await projectWith("capbytes-at", padTo(baseDocument(), MAX_PLAN_BYTES), JSON.stringify(DEFAULT_SEED));

    expect(stagedRunId(await stage(documents))).toMatch(/^prr_/u);
  });

  it("refuses one byte over MAX_PLAN_BYTES and stages nothing", async () => {
    const over = padTo(baseDocument(), MAX_PLAN_BYTES + 1);

    expect(await refusedIn("capbytes-over", over, JSON.stringify(DEFAULT_SEED)))
      .toMatch(/plan is invalid: signed JSON exceeds its byte cap/u);
  });
});

describe("plan and seed document depth cap", () => {
  it("stages a seed nested exactly MAX_PLAN_JSON_DEPTH deep", async () => {
    const deep = nested(MAX_PLAN_JSON_DEPTH);
    const documents = await projectWith("capdepth-at", JSON.stringify(planFor(deep)), JSON.stringify(deep));

    expect(stagedRunId(await stage(documents))).toMatch(/^prr_/u);
  });

  it("refuses one level over MAX_PLAN_JSON_DEPTH and stages nothing", async () => {
    const over = nested(MAX_PLAN_JSON_DEPTH + 1);

    expect(await refusedIn("capdepth-over", JSON.stringify(planFor(over)), JSON.stringify(over)))
      .toMatch(/seed is invalid: JSON nesting exceeds its depth cap/u);
  });

  it("charges the plan document against the same depth cap as the seed", async () => {
    // The two documents share one reader and one pair of constants. Proving the
    // plan leg separately matters because it is the leg an operator authors by
    // hand, and a plan nested past the cap must refuse on DEPTH rather than on
    // the schema rejecting the unknown shape it necessarily also has.
    const deep = JSON.stringify(nested(MAX_PLAN_JSON_DEPTH + 1));

    expect(await refusedIn("capdepth-plan", deep, JSON.stringify(DEFAULT_SEED)))
      .toMatch(/plan is invalid: JSON nesting exceeds its depth cap/u);
  });
});

describe("logical phase count cap", () => {
  it("stages a plan declaring exactly MAX_LOGICAL_PHASES_PER_PLAN phases", async () => {
    const documents = await projectWith(
      "capphases-at", JSON.stringify(chainPlan(MAX_LOGICAL_PHASES_PER_PLAN)), JSON.stringify(DEFAULT_SEED));

    expect(stagedRunId(await stage(documents))).toMatch(/^prr_/u);
  });

  it("refuses one phase over MAX_LOGICAL_PHASES_PER_PLAN and stages nothing", async () => {
    const over = JSON.stringify(chainPlan(MAX_LOGICAL_PHASES_PER_PLAN + 1));

    expect(await refusedIn("capphases-over", over, JSON.stringify(DEFAULT_SEED)))
      .toMatch(/plan is invalid: phases exceeds its item cap/u);
  });
});
