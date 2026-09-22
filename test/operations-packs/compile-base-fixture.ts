/**
 * @file test/operations-packs/compile-base-fixture.ts
 * @description Builds one complete, independently mutable compile request for the
 * plan-compiler suites. The recipe is the shared pack fixture's own recipe with
 * its provider phase removed — reusing it rather than restating a second
 * context -> render -> intent chain keeps one authoring shape under test — plus
 * an active product binding and the host-resolved runtime identities and safety
 * floor. Every test clones this request, mutates one field, and asserts the
 * compiled result or the fail-closed refusal, so the positive baseline stays
 * trustworthy.
 */

import { buildPack, dg } from "./pack-fixture.js";
import type { CompilePackActionRequestV1 } from "../../src/operations-packs/compiler-types.js";
import type { PackPhaseV2, PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import type { ActiveProductBindingV1 } from "../../src/products/binding/types.js";

/** The recipe id the shared pack fixture declares. */
export const RECIPE_ID = "demo.prepare";

/** Attempts every compiled phase declares, so a fixture bound covers its retries. */
const COMPILED_INVOCATION_CEILING = 32;

/**
 * The shared fixture's recipe without its provider phase: a host-handler-only
 * context -> render -> intent chain terminating in exactly one intent phase.
 */
export function compilableRecipe(): PackRecipeV2 {
  const recipe = buildPack().recipes[RECIPE_ID]!;
  recipe.phases = recipe.phases.filter((phase) => phase.kind !== "provider");
  recipe.bounds = { ...recipe.bounds, maxPhaseInvocations: COMPILED_INVOCATION_CEILING };
  return recipe;
}

/** One phase of the compilable recipe, by its declared id. */
function phaseOf(id: string): PackPhaseV2 {
  return compilableRecipe().phases.find((phase) => phase.phaseId === id)!;
}

/** A review gate between the draft and the proposal. */
export function gatePhase(): PackPhaseV2 {
  return {
    phaseId: "review", kind: "gate", dependencies: ["compose"], disposition: "required",
    inputBindings: [{ bindingId: "drafted", source: "phase-output", ref: "compose.draft" }],
    outputSchema: [], bounds: { maxItems: 1, maxOutputBytes: 0 },
    missingInputDisposition: "fail", body: { gateKindId: "review-preparation" },
  };
}

/** The same recipe with a review gate between the draft and the proposal. */
export function recipeWithGate(): PackRecipeV2 {
  const recipe = compilableRecipe();
  recipe.phases = [
    phaseOf("assemble"), phaseOf("compose"), gatePhase(),
    { ...phaseOf("propose"), dependencies: ["review"] },
  ];
  return recipe;
}

/** The select, validate, and reconcile phases the six-family recipe adds. */
function middleWorkPhases(): PackPhaseV2[] {
  const common = {
    dependencies: ["assemble"], disposition: "required" as const,
    inputBindings: [{ bindingId: "evidence-in", source: "phase-output" as const, ref: "assemble.evidence" }],
    outputSchema: [{ fieldId: "evidence", valueKind: "evidence-ref" as const }],
    bounds: { maxItems: 64, maxOutputBytes: 32768 }, missingInputDisposition: "fail" as const,
  };
  return [
    { ...common, phaseId: "filter", kind: "select", body: {
      operation: "dedupe", identityFields: ["item-id"], sortFields: [], filterPredicateIds: [],
      overflowDisposition: "fail", completenessClass: "evidence-coverage" } },
    { ...common, phaseId: "check", kind: "validate", dependencies: ["filter"], body: {
      ruleBindings: [{ ruleId: "rule.nonempty", ruleVersion: "1.0.0", parameters: [{ paramId: "minimum", value: 1 }] }] } },
    { ...common, phaseId: "merge", kind: "reconcile", dependencies: ["check"], body: {
      reconcilePolicyId: "reconcile.default", comparedEvidenceClass: "wiki-page",
      findingClasses: ["identical", "conflicting"] } },
  ];
}

/** The recipe exercising all six work kinds, so every lowering row is covered. */
export function recipeWithAllWorkKinds(): PackRecipeV2 {
  const recipe = compilableRecipe();
  recipe.phases = [
    phaseOf("assemble"), ...middleWorkPhases(),
    { ...phaseOf("compose"), dependencies: ["merge"] }, phaseOf("propose"),
  ];
  return recipe;
}

/**
 * The terminal intent phase both the single-intent and two-phase paper recipes
 * end in: it authors one `wiki-page` draft whose title is the item's `topic`
 * field, plus a bounded constant and a host identity. The two recipes differ only
 * in what feeds it — the action input directly, or a predecessor phase's output.
 */
export function proposePaperPhase(
  dependencies: string[], inputBindings: PackPhaseV2["inputBindings"],
): PackPhaseV2 {
  return {
    phaseId: "propose", kind: "intent", dependencies, disposition: "required",
    inputBindings, outputSchema: [{ fieldId: "mutation", valueKind: "artifact-ref" }],
    bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      intentTemplateRef: "intent.wiki-artifact",
      intents: [{
        mutationKind: "artifact-upsert", targetProfileClass: "wiki-page",
        fieldMappings: [
          { targetField: "title", source: "phase-input", ref: "topic" },
          { targetField: "revision", source: "constant", value: 1 },
          { targetField: "author", source: "host-identity", identityKind: "principal" },
        ],
      }],
    },
  };
}

/**
 * The MINIMAL executable recipe: one intent phase reading the action input
 * directly, so every draft field resolves from real caller input, a bounded
 * constant, and a host identity rather than a predecessor's output.
 */
export function singleIntentRecipe(): PackRecipeV2 {
  const recipe = compilableRecipe();
  recipe.phases = [proposePaperPhase([], [{ bindingId: "topic-in", source: "action-input", ref: "topic" }])];
  return recipe;
}

/**
 * The same minimal recipe with a REQUIRED review gate the intent phase depends
 * on, so the intent phase stays terminal and the plan still lowers to exactly one
 * materialization spec. It is the shape a product surface must refuse: a gate
 * suspends the run, and only re-driving that same run after an operator decision
 * can resume it.
 */
export function singleIntentRecipeWithGate(): PackRecipeV2 {
  const recipe = singleIntentRecipe();
  const intent = recipe.phases[0]!;
  recipe.phases = [
    {
      phaseId: "review", kind: "gate", dependencies: [], disposition: "required",
      inputBindings: [{ bindingId: "topic-in", source: "action-input", ref: "topic" }],
      // A gate publishes nothing, but the pack parser requires every declared
      // ceiling to be at least one, so this recipe stays parseable as a real pack.
      outputSchema: [], bounds: { maxItems: 1, maxOutputBytes: 1 },
      missingInputDisposition: "fail", body: { gateKindId: "review-preparation" },
    },
    { ...intent, dependencies: ["review"] },
  ];
  return recipe;
}

/**
 * A two-phase autosci-shaped action: an eligibility `select` filter over the
 * candidate record (keep it only if it carries its `doi` identity), then an
 * `intent` phase that authors one paper page from the FILTERED item — bound to
 * phase 1's OUTPUT, so the intent reads a predecessor's result rather than the
 * action input. This is the concrete caller that grounds G1 phase-output chaining.
 */
export function twoPhasePaperRecipe(): PackRecipeV2 {
  const recipe = compilableRecipe();
  recipe.phases = [
    {
      phaseId: "pick", kind: "select", dependencies: [], disposition: "required",
      inputBindings: [{ bindingId: "candidate", source: "action-input", ref: "doi" }],
      outputSchema: [{ fieldId: "selected", valueKind: "evidence-ref" }],
      bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
      body: {
        operation: "filter", identityFields: ["doi"], sortFields: [],
        filterPredicateIds: ["has-identity"], overflowDisposition: "fail",
        completenessClass: "evidence-coverage",
      },
    },
    proposePaperPhase(["pick"], [{ bindingId: "selected-in", source: "phase-output", ref: "pick.selected" }]),
  ];
  return recipe;
}

/**
 * The G2 reconcile chain: pick -> compare -> propose. The `compare` phase is a
 * RECONCILE over pick's output — it classifies the proposed paper against the
 * current-store snapshot of the `wiki-page` entity type — and the intent phase
 * depends on it, so the AS-1 ordering (surface collisions BEFORE proposing the
 * apply) is the recipe's own shape. Reconcile publishes findings, not items, so
 * the intent phase still binds pick's output; the findings are read from the
 * evidence store by the suite.
 */
function reconcilePaperRecipe(): PackRecipeV2 {
  const recipe = twoPhasePaperRecipe();
  const [pick, propose] = recipe.phases;
  recipe.phases = [
    pick!,
    {
      phaseId: "compare", kind: "reconcile", dependencies: ["pick"], disposition: "required",
      inputBindings: [{ bindingId: "proposed-in", source: "phase-output", ref: "pick.selected" }],
      outputSchema: [{ fieldId: "findings", valueKind: "evidence-ref" }],
      bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
      body: {
        reconcilePolicyId: "reconcile.default", comparedEvidenceClass: "wiki-page",
        findingClasses: ["absent", "identical", "conflicting"],
      },
    },
    { ...propose!, dependencies: ["compare"] },
  ];
  return recipe;
}

/** A compile request for the pick -> reconcile -> propose paper action. */
export function reconcilePaperRequest(input: { topic: string; doi?: string }): CompilePackActionRequestV1 {
  const base = twoPhasePaperRequest(input);
  return { ...base, pack: { ...base.pack, recipes: { [RECIPE_ID]: reconcilePaperRecipe() } } };
}

/**
 * A single-intent action proposing one RELATION per source (G4b). The relation's
 * structure — relationType, from, to — arrives as caller input, because a pack
 * recipe cannot author string constants by design; the one numeric `confidence`
 * constant proves attributes flow beside the structural fields.
 */
export function citesRelationRequest(
  input: { relationType: string; from: string; to: string },
): CompilePackActionRequestV1 {
  const recipe = compilableRecipe();
  recipe.phases = [{
    phaseId: "propose", kind: "intent", dependencies: [], disposition: "required",
    inputBindings: [{ bindingId: "from-in", source: "action-input", ref: "from" }],
    outputSchema: [{ fieldId: "mutation", valueKind: "artifact-ref" }],
    bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      intentTemplateRef: "intent.wiki-artifact",
      intents: [{
        mutationKind: "relation-upsert", targetProfileClass: "wiki-page",
        fieldMappings: [
          { targetField: "relation-type", source: "phase-input", ref: "relationType" },
          { targetField: "from", source: "phase-input", ref: "from" },
          { targetField: "to", source: "phase-input", ref: "to" },
          { targetField: "confidence", source: "constant", value: 1 },
        ],
      }],
    },
  }];
  const base = requestWithRecipe(recipe);
  const action = base.pack.actions["demo.run"]!;
  const field = { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 } as const;
  return {
    ...base, input,
    pack: {
      ...base.pack,
      actions: {
        "demo.run": { ...action, inputSchema: { relationType: field, from: field, to: field } },
      },
    },
  };
}

/**
 * The two-phase paper recipe with a middle phase binding BOTH sources: the frozen
 * action input AND the pick phase's output. Its dedupe (by `doi`) sees the union
 * — the same candidate arriving once from each source — so its published
 * selection keeps one and excludes one as `duplicate-identity`, which is the
 * observable proof that a both-bound phase's evidence is the concatenation of
 * its bound inputs rather than either one alone.
 */
function bothSourcesRecipe(): PackRecipeV2 {
  const recipe = twoPhasePaperRecipe();
  const [pick] = recipe.phases;
  recipe.phases = [
    pick!,
    {
      phaseId: "union", kind: "select", dependencies: ["pick"], disposition: "required",
      inputBindings: [
        { bindingId: "seed", source: "action-input", ref: "doi" },
        { bindingId: "picked", source: "phase-output", ref: "pick.selected" },
      ],
      outputSchema: [{ fieldId: "selected", valueKind: "evidence-ref" }],
      bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
      body: {
        operation: "dedupe", identityFields: ["doi"], sortFields: [],
        filterPredicateIds: [], overflowDisposition: "fail",
        completenessClass: "evidence-coverage",
      },
    },
    proposePaperPhase(["union"], [{ bindingId: "union-in", source: "phase-output", ref: "union.selected" }]),
  ];
  return recipe;
}

/** A compile request for the both-sources union action, same input schema as the paper action. */
export function bothSourcesPaperRequest(input: { topic: string; doi?: string }): CompilePackActionRequestV1 {
  const base = twoPhasePaperRequest(input);
  return { ...base, pack: { ...base.pack, recipes: { [RECIPE_ID]: bothSourcesRecipe() } } };
}

/**
 * The paper recipe whose TERMINAL intent binds BOTH sources — the frozen action
 * input and the pick phase's output. The completeness regression shape: the
 * executor hands such a terminal the union of its bound sources, so an EMPTY
 * pick selection alongside a present action input is a legitimate one-item
 * plan the terminal can draft against, never a refusal.
 */
export function mixedTerminalPaperRequest(input: { topic: string; doi?: string }): CompilePackActionRequestV1 {
  const base = twoPhasePaperRequest(input);
  const recipe = twoPhasePaperRecipe();
  recipe.phases = [
    recipe.phases[0]!,
    proposePaperPhase(["pick"], [
      { bindingId: "topic-in", source: "action-input", ref: "topic" },
      { bindingId: "selected-in", source: "phase-output", ref: "pick.selected" },
    ]),
  ];
  return { ...base, pack: { ...base.pack, recipes: { [RECIPE_ID]: recipe } } };
}

/**
 * A compile request for the MULTI-SOURCE paper action: one shared topic and a
 * `doi` COLUMN (`string-list`), so the sealed input decodes to one evidence item
 * per doi. The intent additionally maps each item's own `doi` into the draft, so
 * two sources provably produce two DIFFERENT payloads, not two copies.
 */
export function multiSourcePaperRequest(input: { topic: string; doi: readonly string[] }): CompilePackActionRequestV1 {
  const base = twoPhasePaperRequest({ topic: input.topic });
  const action = base.pack.actions["demo.run"]!;
  const recipe = base.pack.recipes[RECIPE_ID]!;
  const propose = recipe.phases.find((phase) => phase.phaseId === "propose")!;
  const body = propose.body as { intents: { fieldMappings: unknown[] }[] };
  const group = body.intents[0]!;
  group.fieldMappings = [...group.fieldMappings, { targetField: "doi", source: "phase-input", ref: "doi" }];
  return {
    ...base,
    input: { topic: input.topic, doi: [...input.doi] },
    pack: {
      ...base.pack,
      actions: {
        "demo.run": {
          ...action,
          inputSchema: {
            ...action.inputSchema,
            doi: { kind: "string-list", required: true, overridable: true, sensitivityDisplay: "normal", maxItems: 8, maxItemBytes: 256 },
          },
        },
      },
    },
  };
}

/** The multi-source input on the SINGLE-intent recipe: the terminal binds the action input directly. */
export function multiSourceSingleIntentRequest(input: { topic: string; doi: readonly string[] }): CompilePackActionRequestV1 {
  const base = multiSourcePaperRequest(input);
  return { ...base, pack: { ...base.pack, recipes: { [RECIPE_ID]: singleIntentRecipe() } } };
}

/** A compile request for the two-phase paper action: a required topic, an optional doi identity. */
export function twoPhasePaperRequest(input: { topic: string; doi?: string }): CompilePackActionRequestV1 {
  const base = requestWithRecipe(twoPhasePaperRecipe());
  const action = base.pack.actions["demo.run"]!;
  return {
    ...base, input,
    pack: {
      ...base.pack,
      actions: {
        "demo.run": {
          ...action,
          inputSchema: {
            topic: { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
            doi: { kind: "string", required: false, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
          },
        },
      },
    },
  };
}

/**
 * A single-intent action whose one artifact-upsert group exercises the PAGE
 * payload rule end to end: a `content` constant for the body, a `tags` field
 * the group's `listFields` hint emits as a one-element list, and the title
 * from caller input. The drive installs a profile REQUIRING title and tags,
 * so a payload that is not a real page cannot re-drive over its own output.
 */
export function pagePayloadPaperRequest(input: { topic: string; tag: string }): CompilePackActionRequestV1 {
  const recipe = compilableRecipe();
  recipe.phases = [{
    phaseId: "propose", kind: "intent", dependencies: [], disposition: "required",
    inputBindings: [{ bindingId: "topic-in", source: "action-input", ref: "topic" }],
    outputSchema: [{ fieldId: "mutation", valueKind: "artifact-ref" }],
    bounds: { maxItems: 4, maxOutputBytes: 65536 }, missingInputDisposition: "fail",
    body: {
      intentTemplateRef: "intent.wiki-artifact",
      intents: [{
        mutationKind: "artifact-upsert", targetProfileClass: "wiki-page",
        listFields: ["tags"],
        fieldMappings: [
          { targetField: "title", source: "phase-input", ref: "topic" },
          { targetField: "tags", source: "phase-input", ref: "tag" },
          { targetField: "content", source: "constant", value: "Body text." },
        ],
      }],
    },
  }];
  const base = requestWithRecipe(recipe);
  const action = base.pack.actions["demo.run"]!;
  return {
    ...base, input,
    pack: {
      ...base.pack,
      actions: {
        "demo.run": {
          ...action,
          inputSchema: {
            topic: { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
            tag: { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
          },
        },
      },
    },
  };
}

/** One verified single-root pack whose action names the compilable recipe. */
function buildCompilablePack(): WorkspaceOperationsPackV2 {
  const pack = buildPack();
  pack.recipes = { [RECIPE_ID]: compilableRecipe() };
  pack.actions = {
    "demo.run": {
      ...pack.actions["demo.run"]!,
      inputSchema: {
        topic: { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
        depth: {
          kind: "integer", required: false, overridable: true, sensitivityDisplay: "normal",
          minimum: 1, maximum: 5, default: 2,
        },
      },
    },
  };
  return pack;
}

/** One active product binding naming the installed package this pack came from. */
function buildBinding(): ActiveProductBindingV1 {
  return {
    schemaVersion: 1, productId: "com.example.demo", productVersion: "1.0.0",
    packageDigest: dg("package"), runtimeAuthorityDigest: dg("runtime-authority"),
    productManifestDigest: dg("product-manifest"), knowledgeProfileDigest: dg("knowledge-profile"),
    operationsPackDigest: dg("operations-pack"), compositionLockDigest: dg("composition-lock"),
    parityLedgerDigest: dg("parity-ledger"), activatedAt: "2026-01-01T00:00:00.000Z",
    activatedBy: { id: "operator", surface: "cli" },
  };
}

/** Build one complete, deeply independent valid compile request. */
export function buildCompileRequest(): CompilePackActionRequestV1 {
  return {
    workspaceId: "research", binding: buildBinding(), pack: buildCompilablePack(),
    actionId: "demo.run", requestedSurface: "cli", input: { topic: "superconductivity" },
    knowledgeRuntimeIdentityDigest: dg("knowledge-runtime"),
    operationsRuntimeIdentityDigest: dg("operations-runtime"),
    safetyFloorDigest: dg("safety-floor"),
  };
}

/** Rebuild a request with one recipe swapped in, keeping every other field. */
export function requestWithRecipe(recipe: PackRecipeV2): CompilePackActionRequestV1 {
  const request = buildCompileRequest();
  return { ...request, pack: { ...request.pack, recipes: { [RECIPE_ID]: recipe } } };
}

/**
 * The §4.4 shape: a PROVIDER phase feeding the terminal intent phase directly,
 * so one extracted entity becomes one proposed page. Shared by the stubbed-
 * invocation journey and the real-process journey, which must exercise the SAME
 * recipe or the cheaper one stops predicting the expensive one.
 */
export function providerIngestRecipe(): PackRecipeV2 {
  const recipe = compilableRecipe();
  const propose = recipe.phases.find((phase) => phase.phaseId === "propose")!;
  recipe.phases = [
    {
      phaseId: "extract", kind: "provider", dependencies: [], disposition: "required",
      inputBindings: [],
      // BOTH fields the shared echo provider answers with: an item carrying a
      // field this schema does not declare is refused, which is the decoder
      // working — so the schema and the provider have to agree.
      outputSchema: [
        { fieldId: "title", valueKind: "string" },
        { fieldId: "definition", valueKind: "string" },
      ],
      bounds: { maxItems: 16, maxOutputBytes: 65_536 }, missingInputDisposition: "fail",
      body: { providerRoleId: "primary-model", requestTemplateRef: "render.provider-request" },
    } as unknown as PackRecipeV2["phases"][number],
    {
      ...propose, dependencies: ["extract"],
      inputBindings: [{ bindingId: "entity-in", source: "phase-output", ref: "extract.title" }],
      bounds: { maxItems: 16, maxOutputBytes: 65_536 },
      body: {
        ...(propose.body as unknown as Record<string, unknown>),
        intents: [{
          mutationKind: "artifact-upsert", targetProfileClass: "wiki-page",
          fieldMappings: [
            { targetField: "title", source: "phase-input", ref: "title" },
            { targetField: "revision", source: "constant", value: 1 },
            { targetField: "author", source: "host-identity", identityKind: "principal" },
          ],
        }],
      },
    } as unknown as PackRecipeV2["phases"][number],
  ];
  return recipe;
}
