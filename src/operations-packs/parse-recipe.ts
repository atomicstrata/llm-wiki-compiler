/**
 * @file src/operations-packs/parse-recipe.ts
 * @description Parser for one FULL PackRecipeV2 (design section 15.1): recipe
 * identity, version, atomicity class, the closed input/output/bounds contracts,
 * the completeness-class sources, and the bounded phase list — each phase carrying
 * its kind-specific closed source body. The recipe authoring grammar is PARSED in
 * full (never deferred): its sub-contracts live in {@link ./recipe-contracts} and
 * its phases in {@link ./parse-phase}, so a later compiler slice can compile an
 * accepted pack without replacing these public types. Because every leaf is a
 * closed shape (slug / dotted ref-id / closed enum / finite scalar / typed
 * reference), section-10.3 forbidden content — a shell string, an absolute or
 * writable path, an `eval(...)` expression, arbitrary JSON — cannot be represented
 * anywhere in the recipe.
 */

import { enumValue, exact, record } from "../operation-bundles/manifest-values.js";
import { assertRecipeId, assertPackVersion } from "./ids.js";
import { parsePhases } from "./parse-phase.js";
import {
  parseCompletenessClasses, parseInputContract, parseOutputContract, parseRecipeBounds,
} from "./recipe-contracts.js";
import type { PackRecipeV2 } from "./recipe-types.js";

const RECIPE_ATOMICITY = [
  "local-bundle-only", "external-effect-only", "non-atomic-external-before-local",
] as const;
const RECIPE_KEYS = [
  "recipeId", "recipeVersion", "atomicityClass", "inputContract",
  "phases", "completenessClasses", "outputContract", "bounds",
] as const;

/** Parse and structurally validate one FULL recipe (section 15.1). */
export function parseRecipe(value: unknown, label: string): PackRecipeV2 {
  const node = record(value, label);
  exact(node, RECIPE_KEYS);
  return {
    recipeId: assertRecipeId(node.recipeId),
    recipeVersion: assertPackVersion(node.recipeVersion),
    atomicityClass: enumValue(node.atomicityClass, RECIPE_ATOMICITY, `${label}.atomicityClass`),
    inputContract: parseInputContract(node.inputContract, `${label}.inputContract`),
    phases: parsePhases(node.phases, `${label}.phases`),
    completenessClasses: parseCompletenessClasses(node.completenessClasses, `${label}.completenessClasses`),
    outputContract: parseOutputContract(node.outputContract, `${label}.outputContract`),
    bounds: parseRecipeBounds(node.bounds, `${label}.bounds`),
  };
}
