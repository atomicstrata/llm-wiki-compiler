/**
 * @file test/preparation-capacity-matrix-projection.test.ts
 * @description Exact cap-boundary coverage for every dimension
 * `assertStageCapacity` enforces (`src/preparations/capacity.ts:99-116`), plus
 * the end-to-end half for the one dimension a staging caller can actually drive
 * there: prepared inputs.
 *
 * FOUR of the eight dimensions cannot be reached through any caller — the CLI
 * supplies exactly one initial input and one new preparation per invocation,
 * a manifest cannot approach 2 MiB while every text field is capped at 1 KiB,
 * and the evidence-object and active-byte ceilings are 2 GiB and 32 GiB. Their
 * boundaries are therefore proven where they are enforced. The table is checked
 * for COMPLETENESS against the projection type rather than trusted to be
 * complete: a dimension added to `StageCapacityProjection` fails the guard until
 * it is given a boundary here.
 *
 * WHICH ENFORCEMENT POINT A CALLER ACTUALLY MEETS, pinned by the last test:
 * `StageCapacityError("prepared-inputs")` is not it. The manifest parser caps
 * `initialEvidence` at the SAME constant (`src/preparations/manifest-parse.ts`)
 * and runs first, inside `prepareStage`, which leaves it the SINGLE enforcement
 * point for that cardinality — deliberately so, since a second count check
 * beside it is a check that can disagree with the executor.
 *
 * What that parser owes a caller is a TYPED refusal, and it now raises
 * `PreparationPlanError`, which IS in the service's refusal allowlist
 * (`src/preparations/service-stage.ts`). It previously raised a bare `Error`,
 * which that allowlist rethrows — so an over-cap set surfaced as a FAULT. The
 * capacity dimension keeps its row in the table and is proven at its own
 * enforcement point above; `test/preparation-stage-typed-refusal.test.ts`
 * carries the service half.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import {
  assertStageCapacity, StageCapacityError, type StageCapacityProjection,
} from "../src/preparations/capacity.js";
import {
  MAX_ACTIVE_NONTERMINAL_RUNS, MAX_ACTIVE_PREPARATION_BYTES,
  MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE, MAX_NEW_PREPARATIONS_PER_STAGING_CALL,
  MAX_PREPARATION_EVIDENCE_OBJECT_BYTES, MAX_PREPARATION_MANIFEST_BYTES,
  MAX_PREPARATION_RUN_BYTES, MAX_PREPARED_INPUTS_PER_RUN,
} from "../src/preparations/constants.js";
import { PreparationPlanError } from "../src/preparations/problems.js";
import { stagePreparationLocked } from "../src/preparations/stage.js";
import { fixturePlan, stageRequest } from "./preparations/store-fixture.js";
import type { PreparationInitialInputV1 } from "../src/preparations/initial-inputs.js";

const root = useTempRoot();

/** A projection with every dimension at zero. */
function zeroProjection(): StageCapacityProjection {
  return {
    newPreparations: 0, activeNonterminalRuns: 0, workspacePreparations: 0, preparedInputs: 0,
    manifestBytes: 0, runBytes: 0, evidenceObjectBytes: 0, activeBytes: 0,
  };
}

/** One dimension: its projection field, its ceiling, and its refusal name. */
type CapCase = readonly [keyof StageCapacityProjection, number, string];

const CAPS: readonly CapCase[] = [
  ["newPreparations", MAX_NEW_PREPARATIONS_PER_STAGING_CALL, "new-preparations"],
  ["activeNonterminalRuns", MAX_ACTIVE_NONTERMINAL_RUNS, "active-runs"],
  ["workspacePreparations", MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE, "workspace-preparations"],
  ["preparedInputs", MAX_PREPARED_INPUTS_PER_RUN, "prepared-inputs"],
  ["manifestBytes", MAX_PREPARATION_MANIFEST_BYTES, "manifest"],
  ["runBytes", MAX_PREPARATION_RUN_BYTES, "run"],
  ["evidenceObjectBytes", MAX_PREPARATION_EVIDENCE_OBJECT_BYTES, "evidence"],
  ["activeBytes", MAX_ACTIVE_PREPARATION_BYTES, "active-bytes"],
];

/** One structured initial input carrying a distinct canonical value. */
function structuredInput(value: unknown, identity: string): PreparationInitialInputV1 {
  return {
    kind: "structured",
    source: {
      value, sourceIdentity: identity, provenanceLabel: "caller", mediaType: "application/json",
      sensitivity: "ordinary", retention: "until-handoff", evidenceKind: "seed",
    },
  };
}

/** `total` declared inputs, the first of which covers the plan's input set. */
function inputSetOf(total: number): PreparationInitialInputV1[] {
  return [
    structuredInput({ seed: "initial-input", version: 1 }, "seed"),
    ...Array.from({ length: total - 1 }, (_unused, index) => structuredInput({ filler: index }, `filler-${index}`)),
  ];
}

/** Assert one projection is refused, and return the typed refusal itself. */
function capacityRefusal(projection: StageCapacityProjection): StageCapacityError {
  try {
    assertStageCapacity(projection);
  } catch (error) {
    if (error instanceof StageCapacityError) return error;
    throw error;
  }
  throw new Error("expected a capacity refusal");
}

describe("assertStageCapacity boundaries", () => {
  it.each(CAPS)("admits %s at exactly its cap", (field, limit) => {
    expect(() => assertStageCapacity({ ...zeroProjection(), [field]: limit })).not.toThrow();
  });

  it.each(CAPS)("refuses %s one unit over its cap, naming the dimension", (field, limit, dimension) => {
    const caught = capacityRefusal({ ...zeroProjection(), [field]: limit + 1 });

    expect(caught.dimension).toBe(dimension);
    expect(caught.message).toContain(dimension);
  });

  it("covers every dimension the projection declares", () => {
    // The table is derived-by-construction from the projection type: a new
    // dimension breaks the zero projection at compile time and this guard at
    // run time, so neither the table nor the caps above can silently fall behind.
    expect([...CAPS.map(([field]) => field)].sort()).toEqual(Object.keys(zeroProjection()).sort());
  });
});

describe("prepared inputs, through the staging transaction", () => {
  it("stages a declared input set of exactly MAX_PREPARED_INPUTS_PER_RUN", async () => {
    await stagePreparationLocked(root.dir, stageRequest());

    const staged = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), {
      initialInputs: inputSetOf(MAX_PREPARED_INPUTS_PER_RUN), dryRun: true,
    }));

    expect(staged.status).toBe("staged");
  }, 60_000);

  it("refuses one input over the cap with a TYPED problem, naming the field", async () => {
    await stagePreparationLocked(root.dir, stageRequest());

    let caught: unknown;
    try {
      await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), {
        initialInputs: inputSetOf(MAX_PREPARED_INPUTS_PER_RUN + 1), dryRun: true,
      }));
    } catch (error) { caught = error; }

    // The class is the whole point: a bare `Error` here is rethrown as a fault.
    expect(caught).toBeInstanceOf(PreparationPlanError);
    expect((caught as Error).message).toBe("initialEvidence exceeds its item cap");
    // Still deliberately asserted: the manifest cap binds before the capacity
    // cap, so the dimension named in `CAPS` is not what a caller meets. Only the
    // CLASS of the refusal changed, not which check owns the cardinality.
    expect(caught).not.toBeInstanceOf(StageCapacityError);
  }, 60_000);
});
