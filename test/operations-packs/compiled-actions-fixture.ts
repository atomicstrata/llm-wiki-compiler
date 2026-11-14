/**
 * @file test/operations-packs/compiled-actions-fixture.ts
 * @description Compile the pack actions the operations-pack suites drive: the
 * single-intent, chained, two-phase paper, multi-source, mixed-bootstrap,
 * relation, reconcile, render and page-payload actions.
 *
 * Split from `runtime-fixture.ts`, which stages and drives runs through the
 * preparation runner: these helpers need only the pack compiler, so a suite that
 * just compiles an action does not load the runner and the operation runtime.
 * Bun loads each test file's import graph afresh.
 */

import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { CompiledPackActionV1 } from "../../src/operations-packs/compiler-types.js";
import {
  bothSourcesPaperRequest, citesRelationRequest, mixedBootstrapRequest, multiSourcePaperRequest, pagePayloadPaperRequest,
  multiSourceRenderRequest, compilableRecipe, reconcilePaperRequest, renderProjectionRequest, requestWithRecipe,
  singleIntentRecipe, twoPhasePaperRequest,
} from "./compile-fixture.js";

/**
 * Compile the minimal single-intent-phase action this slice drives end to end.
 *
 * @param topic - The caller's `topic` input; a different value must produce a
 *   different sealed input set, which is what the exposure drift gate measures.
 */
export function compileSingleIntentAction(topic?: string): Promise<CompiledPackActionV1> {
  const request = requestWithRecipe(singleIntentRecipe());
  return compilePackAction(topic === undefined ? request : { ...request, input: { topic } });
}

/** Compile the context -> render -> intent chain, for the refusal probes. */
export function compileChainedAction(): Promise<CompiledPackActionV1> {
  return compilePackAction(requestWithRecipe(compilableRecipe()));
}

/** Compile the two-phase autosci paper action (select filter -> intent) for G1. */
export function compileTwoPhasePaperAction(input: { topic: string; doi?: string }): Promise<CompiledPackActionV1> {
  return compilePackAction(twoPhasePaperRequest(input));
}

/** Compile the single-group page-payload action (title, listFields tags, content body). */
export function compilePagePayloadAction(input: { topic: string; tag: string }): Promise<CompiledPackActionV1> {
  return compilePackAction(pagePayloadPaperRequest(input));
}

/** Compile the bootstrap-shaped mixed-intents action (three groups, one terminal). */
export function compileMixedBootstrapAction(
  input: { topic: string; doi: readonly string[]; pid: readonly string[]; cites: readonly string[] },
): Promise<CompiledPackActionV1> {
  return compilePackAction(mixedBootstrapRequest(input));
}

/** Compile the multi-source (doi-column) paper action for the given input. */
export function compileMultiSourcePaperAction(input: { topic: string; doi: readonly string[] }): Promise<CompiledPackActionV1> {
  return compilePackAction(multiSourcePaperRequest(input));
}

/** Compile the relation-proposing action (G4b) for the given endpoints. */
export function compileCitesRelationAction(
  input: { relationType: string; from: string; to: string },
): Promise<CompiledPackActionV1> {
  return compilePackAction(citesRelationRequest(input));
}

/** Compile the both-sources union action (action-input + pick output into one dedupe). */
export function compileBothSourcesAction(input: { topic: string; doi?: string }): Promise<CompiledPackActionV1> {
  return compilePackAction(bothSourcesPaperRequest(input));
}

/** Compile the pick -> reconcile -> propose paper action for G2. */
export function compileReconcilePaperAction(input: { topic: string; doi?: string }): Promise<CompiledPackActionV1> {
  return compilePackAction(reconcilePaperRequest(input));
}

/** Compile a render action whose index phase binds the ACTION INPUT directly. */
export function compileActionInputRenderAction(maxOutputBytes = 65536): Promise<CompiledPackActionV1> {
  const recipe = compilableRecipe();
  const [assemble, compose, propose] = recipe.phases;
  if (assemble === undefined || compose === undefined || propose === undefined) throw new Error("fixture recipe shape changed");
  recipe.phases = [
    {
      ...compose, phaseId: "index", dependencies: [],
      inputBindings: [{ bindingId: "topic-in", source: "action-input", ref: "topic" }],
      bounds: { ...compose.bounds, maxOutputBytes },
    },
    { ...propose, dependencies: ["index"], inputBindings: [{ bindingId: "topic-in", source: "action-input", ref: "topic" }] },
  ];
  return compilePackAction(requestWithRecipe(recipe));
}

/** Compile the framed action-input render over a multi-source (doi column) input. */
export function compileMultiSourceRenderAction(input: { topic: string; doi: readonly string[] }): Promise<CompiledPackActionV1> {
  return compilePackAction(multiSourceRenderRequest(input));
}

/** Compile the pick -> render -> propose projection action for G3. */
export function compileRenderProjectionAction(
  input: { topic: string; doi?: string }, heading?: string,
): Promise<CompiledPackActionV1> {
  return compilePackAction(renderProjectionRequest(input, heading));
}
