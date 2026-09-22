/**
 * @file test/operations-packs/pack-render-drive.test.ts
 * @description G3 render-template runtime, proven end to end on a three-phase
 * projection action: the eligibility `pick`, a `render` phase walking the
 * PACK-SHIPPED index template over pick's output, and an `intent` phase whose
 * proposed page payload carries the RENDERED markdown. Before G3 the runtime
 * refused every render phase (`pack-family-runtime-deferred`); here the
 * template resolves at COMPILE time onto the compiled action, the phase renders,
 * and the successor consumes the projection through the ordinary phase-output
 * convention — the wrapped output item — with no render-specific mechanism.
 *
 * The two-heading case is the recipe-determines-output proof: two packs
 * differing ONLY in a template literal drive to two DIFFERENT proposed payload
 * digests, so template content is behavior, not decoration. The unknown-ref
 * case pins compile-time resolution: a render phase naming an undeclared
 * template never stages a run at all.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { renderBothSourcesRequest, renderProjectionRequest } from "./compile-fixture.js";
import {
  compileRenderProjectionAction, driveStagedRun, readPhaseOutput, resultReason,
  stageCompiledAction, stagedRunTracker,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

const ELIGIBLE = { topic: "superconductivity", doi: "10.1/abc" } as const;

/** Drive one projection action and return its terminal draft record. */
async function drivenDraft(heading?: string): Promise<Record<string, unknown>> {
  const run = tracker.add(await stageCompiledAction(await compileRenderProjectionAction(ELIGIBLE, heading)));
  const result = await driveStagedRun(run);
  expect(result.status, resultReason(result)).toBe("handed-off");
  const published = await readPhaseOutput(run, "propose") as { drafts: Record<string, unknown>[] };
  expect(published.drafts).toHaveLength(1);
  return published.drafts[0]!;
}

describe("G3: a render phase walks the pack-shipped template into the proposed page", () => {
  it("hands off a projection whose draft carries the rendered markdown index", async () => {
    const draft = await drivenDraft();
    const fields = draft.fields as Record<string, unknown>;
    // The template's own literal AND the paper's field value, through the chain:
    // pick selected the candidate, render walked the template over it, intent
    // read the wrapped output item. No other path produces this exact string.
    expect(fields.content).toBe("# Papers\n- superconductivity\n");
    expect(fields.format).toBe("markdown");
  });

  it("two packs differing only in a template literal propose two different payloads AND plans", async () => {
    // Template content is inside the plan's recipe-digest fold, so byte-identical
    // plan digests imply byte-identical projection output — the alias-parity
    // claim stays byte-honest all the way down to template literals.
    const [actionA, actionB] = await Promise.all([
      compileRenderProjectionAction(ELIGIBLE, "# Papers\n"),
      compileRenderProjectionAction(ELIGIBLE, "# Reading List\n"),
    ]);
    expect(actionA.planDigest).not.toBe(actionB.planDigest);
    const first = await drivenDraft("# Papers\n");
    const second = await drivenDraft("# Reading List\n");
    expect((second.fields as Record<string, unknown>).content).toBe("# Reading List\n- superconductivity\n");
    expect(second.payloadDigest).not.toBe(first.payloadDigest);
  });

  it("refuses at COMPILE when a render phase names an undeclared template", async () => {
    const request = renderProjectionRequest(ELIGIBLE);
    const pack = { ...request.pack, renderTemplates: {} };
    await expect(compilePackAction({ ...request, pack })).rejects.toThrow(/unknown render template/);
  });

  it("a both-bound render frames the action input AND iterates it beside the predecessor's items", async () => {
    // The documented both-bound semantics, pinned: frame = the action-input
    // item's fields (the top-level field insertion), and the action-input item
    // is ALSO iterated by `each` alongside pick's selected item — so the topic
    // renders once in the heading and twice in the list.
    const run = tracker.add(await stageCompiledAction(await compilePackAction(renderBothSourcesRequest(ELIGIBLE))));
    const result = await driveStagedRun(run);
    expect(result.status, resultReason(result)).toBe("handed-off");
    const published = await readPhaseOutput(run, "index") as { output: string };
    expect(published.output).toBe("# superconductivity\n- superconductivity\n- superconductivity\n");
  });
});
