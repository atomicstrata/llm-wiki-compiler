/**
 * @file test/operations-packs/one-of-drive.test.ts
 * @description The `one-of` admission predicate end to end (section 16.3): a
 * two-phase action — an admitting `select` over the caller's `status` field
 * under a REQUIRED `row-validity` completeness class, then a terminal intent —
 * driven through the production runtime. An in-set value hands off; an
 * out-of-set value (the whitespace variant) records a DURABLE `invalid-value`
 * exclusion plus an `invalid-row` deficit and the run REFUSES at
 * materialization rather than silently dropping the row. The MUTATION CONTROL
 * removes only the predicate from the recipe and the same input hands off,
 * proving the refusal came from this predicate and nothing else.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { CompilePackActionRequestV1 } from "../../src/operations-packs/compiler-types.js";
import type { PackPhaseV2, PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import type { RunPreparationResultV1 } from "../../src/preparations/runner.js";
import { compilableRecipe, proposePaperPhase, requestWithRecipe } from "./compile-fixture.js";
import {
  driveStagedRun, phaseStates, readPhaseOutput, resultReason, stageCompiledAction,
  stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

/** The admitting select phase; `withPredicate: false` is the mutation control. */
function admitPhase(withPredicate: boolean): PackPhaseV2 {
  return {
    phaseId: "admit", kind: "select", dependencies: [], disposition: "required",
    inputBindings: [{ bindingId: "candidate", source: "action-input", ref: "status" }],
    outputSchema: [{ fieldId: "selected", valueKind: "evidence-ref" }],
    bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      operation: "filter", identityFields: ["topic"], sortFields: [],
      filterPredicateIds: withPredicate ? [{ id: "one-of", field: "status", values: ["alpha", "beta"] }] : [],
      overflowDisposition: "fail", completenessClass: "row-validity",
    },
  };
}

/** The admit -> propose recipe with `row-validity` declared refusal-worthy. */
function oneOfRecipe(withPredicate: boolean): PackRecipeV2 {
  const recipe = compilableRecipe();
  recipe.completenessClasses = [
    { classId: "evidence-coverage", disposition: "best-effort" },
    { classId: "row-validity", disposition: "required-complete" },
  ];
  recipe.phases = [
    admitPhase(withPredicate),
    proposePaperPhase(["admit"], [{ bindingId: "selected-in", source: "phase-output", ref: "admit.selected" }]),
  ];
  return recipe;
}

/** The compile request over a `topic` + `status` caller input. */
function oneOfRequest(status: string, withPredicate: boolean): CompilePackActionRequestV1 {
  const base = requestWithRecipe(oneOfRecipe(withPredicate));
  const action = base.pack.actions["demo.run"]!;
  const field = { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 } as const;
  return {
    ...base, input: { topic: "synthesis", status },
    pack: { ...base.pack, actions: { "demo.run": { ...action, inputSchema: { topic: field, status: field } } } },
  };
}

/** Compile, stage, and drive one one-of action for the given status value. */
async function drive(
  status: string, withPredicate = true,
): Promise<{ run: StagedPackRunV1; result: RunPreparationResultV1 }> {
  const run = tracker.add(await stageCompiledAction(await compilePackAction(oneOfRequest(status, withPredicate))));
  return { run, result: await driveStagedRun(run) };
}

describe("one-of predicate end to end", () => {
  it("an in-set status admits the row and the run hands off", async () => {
    const { run, result } = await drive("alpha");
    expect(result.status, resultReason(result)).toBe("handed-off");
    const admitted = await readPhaseOutput(run, "admit") as { selection: unknown; deficits: unknown };
    expect(admitted.selection).toEqual({ included: ["action-input"], excluded: [] });
    expect(admitted.deficits).toEqual([]);
  });

  it("a whitespace status is refused: durable invalid-value exclusion, invalid-row deficit, NO handoff", async () => {
    const { run, result } = await drive(" alpha");
    expect(result.status).toBe("refused");
    // Both phases SUCCEEDED — the refusal is the materializer reading the
    // recorded deficit, not a phase failure hiding the row.
    const states = await phaseStates(run);
    expect(states.get("admit")).toBe("succeeded");
    expect(states.get("propose")).toBe("succeeded");
    const admitted = await readPhaseOutput(run, "admit") as { selection: unknown; deficits: unknown };
    expect(admitted.selection).toEqual({
      included: [], excluded: [{ itemId: "action-input", reason: "invalid-value" }],
    });
    expect(admitted.deficits).toEqual([
      { completenessClass: "row-validity", reason: "invalid-row", droppedCount: 1 },
    ]);
  });

  it("MUTATION CONTROL: the same whitespace input hands off once the predicate is removed", async () => {
    // Identical caller input, identical recipe shape, ONLY the one-of entry
    // deleted: the run must hand off, or the refusal above never witnessed
    // the predicate — the deficit is what one-of adds.
    const { result } = await drive(" alpha", false);
    expect(result.status, resultReason(result)).toBe("handed-off");
  });
});
