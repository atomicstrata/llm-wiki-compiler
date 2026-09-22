/**
 * @file src/operations-packs/compiler.ts
 * @description The deterministic pack-action plan compiler (design sections
 * 15.1, 17.3): one verified pack, one active product binding, one canonical
 * action id, and one caller input become one normalized preparation plan, its
 * canonical document and digest, the execute-time family bindings, the
 * materialization contract, and the sealed initial input set.
 *
 * PURE AND DETERMINISTIC. The compiler reads no filesystem, no clock, no random
 * source, no environment, no provider probe, and no locale-sensitive API. Byte
 * identical requests produce byte identical plan documents and digests, so the
 * alias and direct invocations of one action are provably the same run, and a
 * plan digest can be recomputed anywhere. Every digest and every serialization
 * goes through the repository's single RFC 8785 canonicalizer.
 *
 * IT INVENTS NO AUTHORITY. Product identity, version, and component digests come
 * from the binding; pack identity from the pack; handler identity, contract
 * version, and contract digest from the registered host-handler registry;
 * capability ceiling from the action's own per-surface caps; the safety floor and
 * both runtime identities from the caller. There is no default, no placeholder,
 * and no synthesized digest anywhere in this module.
 *
 * IT SELF-VERIFIES BEFORE RETURNING. The emitted document is reloaded through the
 * plan loader and must digest identically, and the in-memory plan must pass graph
 * validation and worst-case bounds arithmetic. The two are different checks: the
 * reload proves the serialization survives the untrusted-document path, and the
 * in-memory assertions prove the object this module hands its caller — not just
 * its text — is admissible. A failure is a compiler bug and is surfaced, never
 * swallowed.
 */

import type { ProviderRequirementV2 } from "./types.js";
import type { ArtifactEvidenceDescriptorV2, PackProjectionV2, SourceEvidenceDescriptorV2 } from "./recipe-types.js";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { assertPreparationBounds } from "../preparations/plan-bounds.js";
import { validatePreparationPlanGraph } from "../preparations/plan-graph.js";
import { parsePreparationPlan, preparationPlanDigest } from "../preparations/plan-parse.js";
import type {
  NormalizedPhaseV1, NormalizedPreparationPlanV1, PreparationOutputContractV1,
} from "../preparations/plan-types.js";
import type { ActionAuthorityRefV1, AuthorityRefV1, Sha256Digest } from "../preparations/types.js";
import {
  assertInvocationCeiling, assertRecipeFitsPlanCeilings, handoffCapacityFor, runBoundsFor,
} from "./compiler-bounds.js";
import { lowerPhase, type LoweredPhaseV1 } from "./compiler-lowering.js";
import { sealActionInput, type SealedActionInputV1 } from "./compiler-input.js";
import {
  HOST_HANDLER_FAMILY_BY_PHASE_KIND, type CompiledMaterializationSpecV1,
  type CompiledPackActionV1, type CompiledPhaseBindingV1, type CompilePackActionRequestV1,
} from "./compiler-types.js";
import { createHostHandlerRegistry, hostHandlerRefFor } from "./handlers/registry.js";
import type { RenderTemplateV1 } from "./handlers/types.js";
import { RESERVED_EVIDENCE_ITEM_ID, RESERVED_EVIDENCE_ITEM_ID_PREFIX } from "./constants.js";
import { assertPackDigest, isSlugName } from "./ids.js";
import { PackDeferredError, PackParseError } from "./problems.js";
import type { PackActionV2, WorkspaceOperationsPackV2 } from "./types.js";
import type { IntentPhaseBodyV2, PackPhaseV2, PackRecipeV2 } from "./recipe-types.js";

/** Only a durable preparation action compiles to a handoff-capable plan. */
const COMPILED_EXECUTION_MODE = "durable-preparation";

/**
 * The only atomicity class a host-handler-only recipe can honestly declare: every
 * registered family is read-only, so the plan carries no mutating external effect
 * and produces exactly one local bundle.
 */
const COMPILED_ATOMICITY_CLASS = "local-bundle-only";

/** Separates the product id from the profile id in the knowledge authority id. */
const AUTHORITY_ID_SEPARATOR = ".";

/** The recipe phase kind whose output becomes the Milestone A obligation. */
const TERMINAL_PHASE_KIND = "intent";

/** Compile one canonical pack action into a runnable normalized plan. */
export async function compilePackAction(
  request: CompilePackActionRequestV1,
): Promise<CompiledPackActionV1> {
  const action = actionOf(request.pack, request.actionId);
  const recipe = recipeOf(request.pack, action);
  assertNoReservedPhaseIds(recipe);
  assertRecipeFitsPlanCeilings(recipe);
  assertAtomicityIsRepresentable(recipe);
  const lowered = lowerPhases(recipe, request.pack.providerRequirements);
  const phases = lowered.map((item) => item.phase);
  assertRequiredGatesPresent(action, phases);
  const terminal = terminalIntentPhase(recipe);
  const outputContract = outputContractFor(recipe, phases, terminal);
  const input = sealActionInput(action, request.input);
  assertSourceEvidenceColumns(recipe, input.value);
  assertArtifactEvidenceColumns(recipe, input.value);
  const renderTemplates = resolveRenderTemplates(request.pack, recipe);
  const projections = resolveProjections(request.pack, recipe);
  const plan = assemblePlan({ request, action, recipe, phases, outputContract, input, renderTemplates, projections });
  assertInvocationCeiling(recipe, plan.bounds);
  const planDocument = canonicalBytes(plan).toString("utf8");
  const planDigest = preparationPlanDigest(plan);
  assertCompilerSelfConsistency(plan, planDocument, planDigest);
  return {
    plan, planDocument, planDigest, actionId: action.actionId, recipeId: recipe.recipeId,
    phaseBindings: bindingsOf(lowered),
    materializationSpec: materializationSpecFor(recipe, terminal),
    initialInput: { ref: input.ref, bytes: input.bytes, value: input.value },
    renderTemplates,
    projections,
  };
}

/**
 * Refuse a source-evidence input whose three columns disagree (spec §4.1.1).
 *
 * A COMPILE-TIME refusal on purpose: index-aligned columns of different lengths
 * mean the host captured an inconsistent set, and silently zipping the shorter
 * one would seal a digest that belongs to another file — so the plan must never
 * exist. The row count is also capped by the descriptor's own sealed maxItems.
 */
function assertSourceEvidenceColumns(
  recipe: PackRecipeV2, value: Readonly<Record<string, unknown>>,
): void {
  // ONE descriptor per action, refused here rather than half-honoured: the
  // host-side capture fills exactly one descriptor's columns, so a second
  // provider phase declaring its own would compile against columns the host
  // never computed — an accepted configuration that could never run. Refusing
  // at compile makes the constraint a stated contract instead of a surprise.
  const declaring = recipe.phases.filter((phase) => phase.kind === "provider"
    && (phase.body as { sourceEvidenceDescriptor?: unknown }).sourceEvidenceDescriptor !== undefined);
  if (declaring.length > 1) {
    throw new PackParseError(
      `${declaring.length} provider phases declare a sourceEvidenceDescriptor; one action may carry at most one`);
  }
  for (const phase of recipe.phases) {
    if (phase.kind !== "provider") continue;
    const descriptor = (phase.body as { sourceEvidenceDescriptor?: SourceEvidenceDescriptorV2 }).sourceEvidenceDescriptor;
    if (descriptor === undefined) continue;
    const lengths = columnLengths(value, [descriptor.pathsField, descriptor.digestsField, descriptor.byteCountsField]);
    if (columnsDisagree(lengths)) {
      throw new PackParseError(
        `provider phase ${phase.phaseId}: source-evidence columns disagree — `
        + `${descriptor.pathsField}/${descriptor.digestsField}/${descriptor.byteCountsField} `
        + `have lengths ${lengths.join("/")} (a mismatch would seal a digest belonging to another file)`);
    }
    if (lengths[0]! > descriptor.maxItems) {
      throw new PackParseError(
        `provider phase ${phase.phaseId}: ${lengths[0]} source-evidence rows exceed the sealed maxItems of ${descriptor.maxItems}`);
    }
  }
}

/** The zipped column lengths for the given input fields; -1 marks a non-array. */
function columnLengths(value: Readonly<Record<string, unknown>>, fields: readonly string[]): number[] {
  return fields.map((field) => {
    const column = value[field];
    return Array.isArray(column) ? column.length : -1;
  });
}

/** True when zipped columns cannot be trusted: unequal lengths or a non-array. */
function columnsDisagree(lengths: readonly number[]): boolean {
  return new Set(lengths).size !== 1 || lengths[0] === -1;
}

/**
 * Refuse an artifact-evidence input whose three member columns disagree, and
 * more than one declaring phase per action — the same compile-time discipline
 * the source-evidence columns get (a zipped mismatch would seal a digest that
 * belongs to another member).
 */
function assertArtifactEvidenceColumns(
  recipe: PackRecipeV2, value: Readonly<Record<string, unknown>>,
): void {
  const declaring = recipe.phases.filter((phase) => phase.kind === "provider"
    && (phase.body as { artifactEvidenceDescriptor?: unknown }).artifactEvidenceDescriptor !== undefined);
  if (declaring.length > 1) {
    throw new PackParseError(
      `${declaring.length} provider phases declare an artifactEvidenceDescriptor; one action may carry at most one`);
  }
  for (const phase of declaring) {
    const descriptor = (phase.body as { artifactEvidenceDescriptor: ArtifactEvidenceDescriptorV2 }).artifactEvidenceDescriptor;
    const lengths = columnLengths(value, [descriptor.memberNamesField, descriptor.memberDigestsField, descriptor.memberByteCountsField]);
    if (columnsDisagree(lengths)) {
      throw new PackParseError(
        `provider phase ${phase.phaseId}: artifact-evidence member columns disagree — lengths ${lengths.join("/")}`);
    }
    if (lengths[0]! > descriptor.maxItems) {
      throw new PackParseError(
        `provider phase ${phase.phaseId}: ${lengths[0]} artifact-evidence members exceed the sealed maxItems of ${descriptor.maxItems}`);
    }
    if (typeof value[descriptor.refField] !== "string") {
      throw new PackParseError(`provider phase ${phase.phaseId}: artifact-evidence input carries no ${descriptor.refField} ref`);
    }
  }
}

/** Refuse a recipe phase claiming the reserved action-input evidence identity. */
function assertNoReservedPhaseIds(recipe: PackRecipeV2): void {
  for (const phase of recipe.phases) {
    if (phase.phaseId === RESERVED_EVIDENCE_ITEM_ID) {
      throw new PackParseError(
        `phase id ${RESERVED_EVIDENCE_ITEM_ID} is reserved by the evidence-decoding convention`);
    }
    if (phase.phaseId.startsWith(RESERVED_EVIDENCE_ITEM_ID_PREFIX)) {
      throw new PackParseError(
        `phase id prefix ${RESERVED_EVIDENCE_ITEM_ID_PREFIX} is reserved for multi-source input items`);
    }
  }
}

/**
 * Resolve every render phase's templateRef against the pack's declared render
 * templates. An unknown ref is a compile refusal — the runtime never looks a
 * template up, so it can never resolve one the plan was not sealed against.
 */
function resolveRenderTemplates(
  pack: CompilePackActionRequestV1["pack"], recipe: PackRecipeV2,
): Readonly<Record<string, RenderTemplateV1>> {
  const resolved: Record<string, RenderTemplateV1> = {};
  const need = (ref: string, where: string): void => {
    const template = pack.renderTemplates?.[ref];
    if (template === undefined) {
      throw new PackParseError(`recipe ${where} references unknown render template ${ref}`);
    }
    resolved[ref] = template;
  };
  for (const phase of recipe.phases) {
    if (phase.kind === "render") need(phase.body.templateRef, `render phase ${phase.phaseId}`);
    // A PROVIDER phase's request template is resolved here too, so the question
    // it asks is folded into the recipe digest alongside every rendered page —
    // the request is sealed by the same digest that seals the pin and envelope.
    if (phase.kind === "provider") need(phase.body.requestTemplateRef, `provider phase ${phase.phaseId}`);
  }
  return resolved;
}

/**
 * Resolve every projectionRef — on reconcile phases and on intent groups —
 * against the pack's declared projections.
 *
 * Unknown refs refuse at COMPILE for the same reason render templates do: the
 * runtime never looks a projection up, so it can only ever apply one the plan
 * was sealed against.
 */
function resolveProjections(
  pack: CompilePackActionRequestV1["pack"], recipe: PackRecipeV2,
): Readonly<Record<string, PackProjectionV2>> {
  const resolved: Record<string, PackProjectionV2> = {};
  const need = (ref: string, where: string): void => {
    const projection = pack.projections?.[ref];
    if (projection === undefined) {
      throw new PackParseError(`recipe ${where} references unknown projection ${ref}`);
    }
    resolved[ref] = projection;
  };
  for (const phase of recipe.phases) {
    if (phase.kind === "reconcile" && phase.body.projectionRef !== undefined) {
      need(phase.body.projectionRef, `reconcile phase ${phase.phaseId}`);
    }
    if (phase.kind !== "intent") continue;
    for (const group of phase.body.intents) {
      if (group.projectionRef === undefined) continue;
      need(group.projectionRef, `intent phase ${phase.phaseId}`);
      // A projection's targets take the PAGE vocabulary, and the runtime
      // substitutes them for EVERY mutation kind — so a non-page group naming a
      // page-shaped projection would persist a camelCase key into a draft whose
      // shape is kept slug-only. Refused HERE so the incompatibility cannot be
      // SEALED into a plan and discovered only at terminal execution; the
      // runtime keeps its own check as defence in depth.
      assertProjectionKindCompatible(resolved[group.projectionRef]!, group.mutationKind, phase.phaseId);
    }
  }
  return resolved;
}

/** Mutation kinds whose draft becomes a PAGE (see handlers/page-payload). */
const PAGE_DRAFT_KINDS: ReadonlySet<string> = new Set([
  "artifact-upsert", "artifact-update", "artifact-delete",
]);

/**
 * Refuse a NON-page intent group naming a projection whose targets are not all
 * slugs: the projection would supply that group's draft fields wholesale, and a
 * relation draft's vocabulary is slug-only by construction.
 */
function assertProjectionKindCompatible(
  projection: PackProjectionV2, mutationKind: string, phaseId: string,
): void {
  if (PAGE_DRAFT_KINDS.has(mutationKind)) return;
  for (const mapping of projection.fieldMappings) {
    if (!isSlugName(mapping.targetField)) {
      throw new PackParseError(
        `intent phase ${phaseId}: a ${mutationKind} group may not name projection `
        + `${projection.projectionId}, whose target ${mapping.targetField} is not a slug`);
    }
  }
}

/** The everything-but-bounds inputs one plan assembly reads. */
interface PlanAssemblyV1 {
  readonly request: CompilePackActionRequestV1;
  readonly action: PackActionV2;
  readonly recipe: PackRecipeV2;
  readonly phases: readonly NormalizedPhaseV1[];
  readonly outputContract: PreparationOutputContractV1;
  readonly input: SealedActionInputV1;
  readonly renderTemplates: Readonly<Record<string, RenderTemplateV1>>;
  readonly projections: Readonly<Record<string, PackProjectionV2>>;
}

/** Build the complete plan, declaring exactly its computed worst-case envelope. */
function assemblePlan(assembly: PlanAssemblyV1): NormalizedPreparationPlanV1 {
  const { request, action, recipe, phases, outputContract, input, renderTemplates, projections } = assembly;
  const draft: Omit<NormalizedPreparationPlanV1, "bounds"> = {
    schemaVersion: 1, executionMode: COMPILED_EXECUTION_MODE,
    atomicityClass: COMPILED_ATOMICITY_CLASS, workspaceId: request.workspaceId,
    knowledgeAuthority: knowledgeAuthorityOf(request),
    operationsAuthority: operationsAuthorityOf(request),
    actionAuthority: actionAuthorityOf(request, action),
    // The digest folds the recipe AND the resolved render templates, because
    // both are what the run will execute: a template body is behavior exactly as
    // a recipe body is, and folding it here is what keeps "byte-identical plan
    // digest" meaning byte-identical projection output — the alias-parity claim
    // stays byte-honest.
    // Projections join the fold for the same reason templates did: a projection
    // decides what the run COMPARES and what it WRITES, so changing one changes
    // behaviour and must change the plan digest.
    recipeDigest: assertPackDigest(canonicalDigest({ recipe, renderTemplates, projections })),
    initialInputSet: input.ref, phases: [...phases], outputContract,
    safetyFloorDigest: request.safetyFloorDigest,
    // The parent graft is CANONICAL: folding it into the plan before the digest
    // is what makes a parent-bound run reproduce its planDigest on resume and
    // lets verifyParent park a preparation whose parent run is gone. Omitted key
    // when there is no parent, so unparented actions stay byte-identical.
    ...(request.workflowParent === undefined ? {} : { workflowParent: request.workflowParent }),
  };
  return { ...draft, bounds: runBoundsFor(draft) };
}

/** The active knowledge profile authority named by the binding and the pack. */
function knowledgeAuthorityOf(request: CompilePackActionRequestV1): AuthorityRefV1 {
  const profileId = request.pack.workspaceContract.requiredKnowledgeProfileId;
  return {
    id: `${request.binding.productId}${AUTHORITY_ID_SEPARATOR}${profileId}`,
    version: request.binding.productVersion,
    digest: request.binding.knowledgeProfileDigest,
    runtimeIdentityDigest: request.knowledgeRuntimeIdentityDigest,
  };
}

/** The active operations-pack authority named by the pack and the binding. */
function operationsAuthorityOf(request: CompilePackActionRequestV1): AuthorityRefV1 {
  return {
    id: request.pack.packId, version: request.pack.packVersion,
    digest: request.binding.operationsPackDigest,
    runtimeIdentityDigest: request.operationsRuntimeIdentityDigest,
  };
}

/**
 * The action authority. The handler contract digest pins the registered family
 * that produces this action's terminal output — the same contract the runner
 * requires the materializer to declare, so the plan pin and the materializer
 * cannot drift apart.
 */
function actionAuthorityOf(
  request: CompilePackActionRequestV1, action: PackActionV2,
): ActionAuthorityRefV1 {
  const capabilityClassCeiling = action.requestedSurfaceCaps[request.requestedSurface];
  if (capabilityClassCeiling === undefined) {
    throw new PackParseError(`action requests no capability on the ${request.requestedSurface} surface`);
  }
  return {
    actionId: action.actionId,
    actionDescriptorDigest: assertPackDigest(canonicalDigest(action)),
    handlerContractDigest: terminalHandlerContractDigest(),
    requestedSurface: request.requestedSurface, capabilityClassCeiling,
  };
}

/** The contract digest of the family that compiles the terminal obligation. */
function terminalHandlerContractDigest(): Sha256Digest {
  return hostHandlerRefFor(HOST_HANDLER_FAMILY_BY_PHASE_KIND[TERMINAL_PHASE_KIND]).handlerContractDigest;
}

/** Resolve the named action, refusing anything but a durable preparation. */
function actionOf(pack: WorkspaceOperationsPackV2, actionId: string): PackActionV2 {
  const action = new Map(Object.entries(pack.actions)).get(actionId);
  if (action === undefined) throw new PackParseError(`pack declares no action ${actionId}`);
  if (action.execution.kind !== "preparation") {
    throw new PackDeferredError("configuration actions compile through the configuration flow authority");
  }
  if (action.execution.executionMode !== COMPILED_EXECUTION_MODE) {
    throw new PackDeferredError("ephemeral-read actions cannot declare the handoff a compiled plan requires");
  }
  return action;
}

/** Resolve the recipe the action's execution names. */
function recipeOf(pack: WorkspaceOperationsPackV2, action: PackActionV2): PackRecipeV2 {
  if (action.execution.kind !== "preparation") throw new PackParseError("action is not a preparation");
  const recipe = new Map(Object.entries(pack.recipes)).get(action.execution.recipeRef);
  if (recipe === undefined) throw new PackParseError(`pack declares no recipe ${action.execution.recipeRef}`);
  return recipe;
}

/** Refuse a recipe whose declared atomicity a host-handler-only plan cannot hold. */
function assertAtomicityIsRepresentable(recipe: PackRecipeV2): void {
  if (recipe.atomicityClass !== COMPILED_ATOMICITY_CLASS) {
    throw new PackParseError("a host-handler-only recipe must declare local-bundle-only atomicity");
  }
}

/** Lower every recipe phase, keeping declaration order for a stable plan. */
function lowerPhases(
  recipe: PackRecipeV2, requirements: readonly ProviderRequirementV2[],
): readonly LoweredPhaseV1[] {
  const context = {
    resolve: createHostHandlerRegistry().resolve,
    completenessClasses: new Set(recipe.completenessClasses.map((entry) => entry.classId)),
    // Keyed by role so a provider phase resolves its OWN declaration; a phase
    // naming an undeclared role is refused rather than silently unbounded.
    providerRequirements: new Map(requirements.map((requirement) => [requirement.roleId, requirement])),
  };
  return recipe.phases.map((phase) => lowerPhase(phase, context));
}

/** The execute-time family bindings, one per lowered work phase. */
function bindingsOf(lowered: readonly LoweredPhaseV1[]): readonly CompiledPhaseBindingV1[] {
  return lowered.flatMap((item) => (item.binding === undefined ? [] : [item.binding]));
}

/** Refuse an action requesting a gate its recipe never declares (section 15.4). */
function assertRequiredGatesPresent(action: PackActionV2, phases: readonly NormalizedPhaseV1[]): void {
  const declared: ReadonlySet<string> = new Set(
    phases.flatMap((phase) => (phase.gate === undefined ? [] : [phase.gate.gateKind])),
  );
  for (const required of action.requiredGates ?? []) {
    if (!declared.has(required)) throw new PackParseError(`action requires an undeclared gate: ${required}`);
  }
}

/** The single intent phase whose output becomes the Milestone A obligation. */
function terminalIntentPhase(recipe: PackRecipeV2): Extract<PackPhaseV2, { kind: "intent" }> {
  const intents = recipe.phases.filter((phase) => phase.kind === TERMINAL_PHASE_KIND);
  if (intents.length !== 1) {
    throw new PackParseError("a compiled recipe must declare exactly one intent phase to produce its obligation");
  }
  return intents[0]!;
}

/**
 * The declared output contract. Producers are the recipe's SINK phases — the
 * phases nothing depends on — which is what makes every other phase reachable
 * from a declared output. The terminal intent phase must be one of them, or the
 * obligation would be derived from work the output contract does not claim.
 */
function outputContractFor(
  recipe: PackRecipeV2, phases: readonly NormalizedPhaseV1[],
  terminal: Extract<PackPhaseV2, { kind: "intent" }>,
): PreparationOutputContractV1 {
  const dependedOn = new Set(phases.flatMap((phase) => phase.dependsOn));
  const producingPhaseIds = phases
    .map((phase) => phase.logicalPhaseId)
    .filter((logicalPhaseId) => !dependedOn.has(logicalPhaseId));
  if (!producingPhaseIds.includes(terminal.phaseId)) {
    throw new PackParseError("the intent phase must be terminal to produce the compiled obligation");
  }
  return { producingPhaseIds, handoffCapacity: handoffCapacityFor(recipe, terminal.bounds) };
}

/** The obligation contract the materializer binds at finalization. */
function materializationSpecFor(
  recipe: PackRecipeV2, terminal: Extract<PackPhaseV2, { kind: "intent" }>,
): CompiledMaterializationSpecV1 {
  const body: IntentPhaseBodyV2 = terminal.body;
  const allClasses = [...new Set(body.intents.map((group) => group.targetProfileClass))];
  const pageClasses = [...new Set(body.intents
    .filter((group) => group.mutationKind === "artifact-upsert")
    .map((group) => group.targetProfileClass))];
  return {
    producingPhaseId: terminal.phaseId,
    targetProfileClasses: allClasses, pageProfileClasses: pageClasses,
    outputEvidenceClass: recipe.outputContract.evidenceClass,
    requiredCompletenessClasses: recipe.completenessClasses
      .filter((entry) => entry.disposition === "required-complete")
      .map((entry) => entry.classId),
    maximumPayloadRefs: terminal.bounds.maxItems, maximumPayloadBytes: terminal.bounds.maxOutputBytes,
    handlerContractDigest: terminalHandlerContractDigest(),
  };
}

/**
 * Prove the emitted plan is admissible before it is returned. The reload proves
 * the canonical document survives the untrusted-document loader and still
 * digests identically; the two in-memory assertions prove the object itself —
 * the graph the caller will drive and the envelope it will be staged against.
 */
function assertCompilerSelfConsistency(
  plan: NormalizedPreparationPlanV1, planDocument: string, planDigest: Sha256Digest,
): void {
  const reloaded = parsePreparationPlan(planDocument);
  if (preparationPlanDigest(reloaded) !== planDigest) {
    throw new PackParseError("compiled plan does not round-trip through the plan loader");
  }
  validatePreparationPlanGraph(plan);
  assertPreparationBounds(plan);
}
