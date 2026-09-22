/**
 * @file src/operations-packs/parse.ts
 * @description Bounded, duplicate-key-free structural loader for one immutable
 * single-root WorkspaceOperationsPackV2 (design section 10.1). It rebuilds an
 * allowlisted record through the shared canonical-JSON unique-key parser, rejects
 * unknown and missing fields, holds every caller-influenced identity to its
 * closed grammar, and fails closed. This slice is single-root only and refuses,
 * rather than under-parses, the deferred authorities so a refusal is distinct
 * from an unknown-field rejection:
 *   - `imports` present -> refused (multi-root composition deferred);
 *   - a non-empty `settingSchema` -> refused (settings authority deferred);
 *   - a non-empty `contextRecipes`, `deterministicPolicies`, `intentTemplates`,
 *     `configurationFlows`, `experienceResources`, or `readinessRules` ->
 *     refused (declarative-content kind deferred).
 * `renderTemplates` is PARSED, not deferred: a pack ships the closed declarative
 * templates its render phases name, each rebuilt through the closed node grammar
 * in {@link ./parse-render-template}. The empty or absent form of every deferred
 * collection is accepted. Composition and cross-reference checks are the
 * composition module's job; this layer proves shape only.
 */

import { array, exact, record, textValue, type JsonRecord } from "../operation-bundles/manifest-values.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { MAX_DISPLAY_TEXT_BYTES, MAX_ROOT_OPERATIONS_PACK_BYTES } from "../products/constants.js";
import { MAX_PACK_ACTIONS, MAX_PACK_ALIASES, MAX_PACK_RECIPES, MAX_PACK_RENDER_TEMPLATES, MAX_PROVIDER_REQUIREMENTS } from "./constants.js";
import { assertActionId, assertPackId, assertRecipeId, assertPackVersion, assertRefId } from "./ids.js";
import { parseAction } from "./parse-action.js";
import { parseAlias } from "./parse-alias.js";
import {
  parseContractRequirements, parseProviderRequirement, parseWorkspaceContract,
} from "./parse-contracts.js";
import { parseProjection } from "./parse-phase-bodies.js";
import { parseRecipe } from "./parse-recipe.js";
import { parseRenderTemplate } from "./parse-render-template.js";
import { PackDeferredError, PackParseError, asPackProblem } from "./problems.js";
import type { PackProjectionV2 } from "./recipe-types.js";
import type { PackRecipeV2 } from "./recipe-types.js";
import type { RenderTemplateV1 } from "./handlers/types.js";
import type {
  AliasDescriptorV1, PackActionV2, ProviderRequirementV2, WorkspaceOperationsPackV2,
} from "./types.js";
import { assertUniqueStrings, parseObjectMap } from "./values.js";

const PACK_SCHEMA_VERSION = 2 as const;
const TOP_REQUIRED = [
  "schemaVersion", "packId", "packVersion", "displayName", "minLlmwikiVersion",
  "requires", "providerRequirements", "workspaceContract", "recipes", "actions",
] as const;
const TOP_OPTIONAL = [
  "imports", "settingSchema", "contextRecipes", "deterministicPolicies", "renderTemplates", "projections",
  "intentTemplates", "configurationFlows", "aliases", "experienceResources", "readinessRules",
] as const;
const DEFERRED_RECORD_FIELDS = [
  "contextRecipes", "deterministicPolicies", "intentTemplates", "configurationFlows",
] as const;
const DEFERRED_ARRAY_FIELDS = ["experienceResources", "readinessRules"] as const;

/** Refuse a present, non-empty deferred record-shaped collection. */
function refuseNonEmptyRecord(value: unknown, field: string, reason: string): void {
  if (value !== undefined && Object.keys(record(value, field)).length > 0) throw new PackDeferredError(reason);
}

/** Refuse a present, non-empty deferred array-shaped collection. */
function refuseNonEmptyArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new PackParseError(`${field} must be an array`);
  if (value.length > 0) throw new PackDeferredError(`${field} (declarative-content kind)`);
}

/** Fail closed on every deferred authority this slice does not implement. */
function enforceDeferrals(root: JsonRecord): void {
  if (root.imports !== undefined) throw new PackDeferredError("pack imports (multi-root composition)");
  refuseNonEmptyRecord(root.settingSchema, "settingSchema", "settingSchema (settings authority)");
  for (const field of DEFERRED_RECORD_FIELDS) {
    refuseNonEmptyRecord(root[field], field, `${field} (declarative-content kind)`);
  }
  for (const field of DEFERRED_ARRAY_FIELDS) refuseNonEmptyArray(root[field], field);
}

/** Parse the pack's scalar identity, contract pins, and workspace contract. */
function parsePackScalars(root: JsonRecord): Pick<WorkspaceOperationsPackV2,
  "schemaVersion" | "packId" | "packVersion" | "displayName" | "minLlmwikiVersion" | "requires" | "workspaceContract"> {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    packId: assertPackId(root.packId),
    packVersion: assertPackVersion(root.packVersion),
    displayName: textValue(root.displayName, "displayName", MAX_DISPLAY_TEXT_BYTES),
    minLlmwikiVersion: assertPackVersion(root.minLlmwikiVersion),
    requires: parseContractRequirements(root.requires, "requires"),
    workspaceContract: parseWorkspaceContract(root.workspaceContract, "workspaceContract"),
  };
}

/** Parse one named object map and require each key to equal its declared id. */
function parseNamedMap<T>(
  value: unknown, label: string, cap: number,
  keyAssert: (key: unknown) => string,
  parseEntry: (entryValue: unknown, entryLabel: string) => T,
  idOf: (entry: T) => string,
): Record<string, T> {
  const map = parseObjectMap(value, label, cap, keyAssert, parseEntry);
  for (const [key, entry] of Object.entries(map)) {
    if (idOf(entry) !== key) throw new PackParseError(`${label} key ${key} does not match its declared id`);
  }
  return map;
}

/** Parse the bounded, distinct-role provider-requirement list (section 13.1). */
function parseProviderRequirements(value: unknown): ProviderRequirementV2[] {
  const reqs = array(value, "providerRequirements", MAX_PROVIDER_REQUIREMENTS)
    .map((item, index) => parseProviderRequirement(item, `providerRequirements[${index}]`));
  assertUniqueStrings(reqs.map((requirement) => requirement.roleId), "providerRequirements");
  return reqs;
}

/** Parse the required recipe, action, and provider collections plus optional members. */
function parsePackCollections(root: JsonRecord): Pick<WorkspaceOperationsPackV2,
  "providerRequirements" | "recipes" | "actions" | "aliases" | "renderTemplates" | "projections"> {
  const recipes = parseNamedMap<PackRecipeV2>(root.recipes, "recipes", MAX_PACK_RECIPES, assertRecipeId, parseRecipe, (recipe) => recipe.recipeId);
  const actions = parseNamedMap<PackActionV2>(root.actions, "actions", MAX_PACK_ACTIONS, assertActionId, parseAction, (action) => action.actionId);
  const base = { providerRequirements: parseProviderRequirements(root.providerRequirements), recipes, actions };
  const withTemplates = root.renderTemplates === undefined || Object.keys(record(root.renderTemplates, "renderTemplates")).length === 0
    ? base
    : { ...base, renderTemplates: parseNamedMap<RenderTemplateV1>(root.renderTemplates, "renderTemplates", MAX_PACK_RENDER_TEMPLATES, assertRefId, parseRenderTemplate, (template) => template.templateId) };
  const withProjections = root.projections === undefined || Object.keys(record(root.projections, "projections")).length === 0
    ? withTemplates
    : { ...withTemplates, projections: parseNamedMap<PackProjectionV2>(root.projections, "projections", MAX_PACK_RENDER_TEMPLATES, assertRefId, parseProjection, (projection) => projection.projectionId) };
  if (root.aliases === undefined) return withProjections;
  const aliases: AliasDescriptorV1[] = array(root.aliases, "aliases", MAX_PACK_ALIASES)
    .map((item, index) => parseAlias(item, `aliases[${index}]`));
  return { ...withProjections, aliases };
}

/** Rebuild and structurally validate one single-root operations pack (section 10.1). */
export function parseOperationsPack(text: string): WorkspaceOperationsPackV2 {
  return asPackProblem(() => {
    const root = record(parseBoundedUniqueJson(text, MAX_ROOT_OPERATIONS_PACK_BYTES), "operations pack");
    exact(root, TOP_REQUIRED, TOP_OPTIONAL);
    if (root.schemaVersion !== PACK_SCHEMA_VERSION) throw new PackParseError("operations pack schemaVersion must be 2");
    enforceDeferrals(root);
    return { ...parsePackScalars(root), ...parsePackCollections(root) };
  });
}
