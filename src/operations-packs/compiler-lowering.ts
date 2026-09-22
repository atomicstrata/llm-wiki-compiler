/**
 * @file src/operations-packs/compiler-lowering.ts
 * @description Per-phase lowering from the closed recipe grammar (design section
 * 15.2) to the closed normalized plan phase (section 10.2). One recipe phase
 * becomes one logical plan phase plus, for a work phase, the execute-time binding
 * of its registered family to its REAL closed body.
 *
 * WHAT LOWERS AND WHAT REFUSES. The six work kinds lower to a `host-handler`
 * executor pinned to the registered family's exact contract digest, and a `gate`
 * lowers to one of the eight closed gate kinds. Three recipe constructs are
 * REFUSED rather than approximated, because the normalized plan grammar cannot
 * carry them and a lossy lowering would produce a plan that does not mean what
 * the recipe said:
 *   - a `provider` phase needs the Task 4 provider pin authority (no pin digest,
 *     capability id, or contract digest is derivable here);
 *   - a `join` phase would lower to a `join` role phase, which the runner cannot
 *     drive — the attempt boundary parks any phase carrying no executor, so such
 *     a plan strands instead of reaching handoff;
 *   - a `bounded-repeat` expansion needs a continuation rule (fixed count, until
 *     empty, or while boolean) that the recipe grammar does not declare.
 * A `context-evidence` input binding, a `keep-first`/`keep-last` duplicate
 * disposition, and a non-`fail` missing-input disposition are refused for the
 * same reason: the plan grammar has no field that means them.
 */

import { RESERVED_PROVIDER_INPUT_KEYS } from "../preparations/plan-types.js";
import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import type {
  HostHandlerResolutionV1, HostHandlerRefV1,
} from "../preparations/attempts/types.js";
import type {
  ExpansionDeficitDisposition, NormalizedPhaseV1, PhaseExpansionV1,
  PhaseGateContractV1, PhaseGateKind, PhaseInputBindingV1,
} from "../preparations/plan-types.js";
import type { ProviderRequirementV2 } from "./types.js";
import { gatePhaseBounds, hostHandlerPhaseBounds, providerPhaseBounds } from "./compiler-bounds.js";
import {
  HOST_HANDLER_FAMILY_BY_PHASE_KIND, type CompiledPhaseBindingV1, type WorkPhaseKindV1,
} from "./compiler-types.js";
import { hostHandlerRefFor } from "./handlers/registry.js";
import { assertPackDigest } from "./ids.js";
import { PackDeferredError, PackParseError } from "./problems.js";
import { flattenPageEvidenceExposures } from "./parse-page-evidence.js";
import type {
  ExpansionControlsV2, PackPhaseV2, PhaseInputBindingV2,
  ArtifactEvidenceDescriptorV2, SourceEvidenceDescriptorV2,
  PageEvidenceCaptureV2,
  PageEvidenceDescriptorV2,
} from "./recipe-types.js";

/** The eight closed gate kinds a recipe `gateKindId` may name (section 17.1). */
const GATE_KINDS: readonly PhaseGateKind[] = [
  "confirm-input-exposure", "confirm-cost", "confirm-external-effect",
  "confirm-residual-risk", "review-selection", "review-preparation",
  "discussion-checkpoint", "confirm-abandonment",
];

/** The two item identities the plan grammar admits, keyed by policy id. */
const ITEM_IDENTITY_BY_POLICY = {
  "host-id": "host-id", "canonical-item-digest": "canonical-item-digest",
} as const satisfies Readonly<Record<string, "host-id" | "canonical-item-digest">>;

/** The duplicate dispositions the plan grammar admits, keyed by recipe value. */
const DUPLICATE_DISPOSITION_BY_SOURCE = {
  reject: "fail", dedupe: "deduplicate",
} as const satisfies Readonly<Record<string, "fail" | "deduplicate">>;

/** One recipe phase whose kind selects a registered host-handler family. */
type WorkPhaseV2 = Extract<PackPhaseV2, { kind: WorkPhaseKindV1 }>;

/** The work phase kinds, derived from the single lowering table. */
const WORK_PHASE_KINDS: ReadonlySet<string> = new Set(Object.keys(HOST_HANDLER_FAMILY_BY_PHASE_KIND));

/** Everything one phase lowering needs from the recipe and the host registry. */
export interface PhaseLoweringContextV1 {
  readonly resolve: (ref: HostHandlerRefV1) => HostHandlerResolutionV1;
  readonly completenessClasses: ReadonlySet<string>;
  /** The pack's declared provider requirements, keyed by role id. */
  readonly providerRequirements: ReadonlyMap<string, ProviderRequirementV2>;
}

/** One lowered phase and, for a work phase, its execute-time family binding. */
export interface LoweredPhaseV1 {
  readonly phase: NormalizedPhaseV1;
  readonly binding?: CompiledPhaseBindingV1;
}

/** True when this recipe phase lowers to a registered host-handler family. */
function isWorkPhase(phase: PackPhaseV2): phase is WorkPhaseV2 {
  return WORK_PHASE_KINDS.has(phase.kind);
}

/** Lower one recipe phase, refusing every construct the plan cannot carry. */
export function lowerPhase(source: PackPhaseV2, context: PhaseLoweringContextV1): LoweredPhaseV1 {
  assertRepresentable(source);
  if (isWorkPhase(source)) return lowerWorkPhase(source, context);
  if (source.kind === "gate") return { phase: lowerGatePhase(source, context) };
  if (source.kind === "provider") return { phase: lowerProviderPhase(source, context) };
  throw new PackDeferredError("join phases require an Orchestration V2 join executor");
}

/**
 * Lower one provider phase to a `provider-capability` executor.
 *
 * THE PIN AND THE ENVELOPE BOTH COME FROM THE PACK'S OWN DECLARATION and are
 * sealed into the plan digest, so an approved plan can only reach the provider
 * it was approved against, asking for no more than it was approved to ask for.
 * Resolving either at run time would let one approved plan behave differently
 * on two runs.
 *
 * A ROLE MISSING EITHER IS REFUSED rather than defaulted. "Whichever provider is
 * installed" and "whatever budget is available" are exactly the unsealed
 * behaviours the digest exists to prevent.
 *
 * The phase carries NO execute-time binding: a host-handler family is dispatched
 * by the runtime itself, but a provider leg is supplied by the HOST through the
 * runner's `legFor`, so neither the runner nor this compiler names a transport.
 */
function lowerProviderPhase(
  source: Extract<PackPhaseV2, { kind: "provider" }>, context: PhaseLoweringContextV1,
): NormalizedPhaseV1 {
  const requirement = context.providerRequirements.get(source.body.providerRoleId);
  if (requirement === undefined) {
    throw new PackParseError(
      `provider phase ${source.phaseId} names undeclared provider role ${source.body.providerRoleId}`);
  }
  if (requirement.defaultProviderPin === undefined) {
    throw new PackParseError(
      `provider role ${requirement.roleId} declares no defaultProviderPin to seal into the plan`);
  }
  if (requirement.requestedBounds === undefined) {
    throw new PackParseError(
      `provider role ${requirement.roleId} declares no requestedBounds to seal into the plan`);
  }
  return {
    ...commonPhase(source), role: "work",
    executor: {
      kind: "provider-capability",
      providerPinDigest: requirement.defaultProviderPin,
      capabilityId: requirement.capabilityId,
      capabilityContractDigest: requirement.capabilityContractDigest,
      // The declared output contract travels INTO the plan, not just its digest,
      // because a successor has to decode the provider's answer against it. A
      // digest can only detect drift; it cannot say what the fields were.
      outputSchema: source.outputSchema.map((field) => ({ fieldId: field.fieldId, valueKind: field.valueKind })),
      maximumOutputItems: source.bounds.maxItems,
      // The template the provider's request is rendered from, so the runtime
      // can ASK what the plan says it asks.
      requestTemplateRef: source.body.requestTemplateRef,
      // The sealed source-evidence descriptor, when the pack declares one —
      // what this provider may READ, beside what it is ASKED. Spread so an
      // undeclared descriptor leaves the executor byte-identical to before the
      // field existed, keeping every pre-existing plan digest stable.
      ...(source.body.sourceEvidenceDescriptor === undefined ? {} : {
        sourceEvidenceDescriptor: { ...assertSealableDescriptor(source.body.sourceEvidenceDescriptor, source.phaseId) },
      }),
      // The sealed artifact-evidence descriptor — what member-bearing artifact
      // this provider may READ. Same spread discipline: absent leaves the
      // executor byte-identical, keeping pre-existing plan digests stable. A
      // phase declaring BOTH evidence kinds refuses: the host materializes ONE
      // evidence table per phase, and two would collide on the input region.
      ...(source.body.artifactEvidenceDescriptor === undefined ? {} : {
        artifactEvidenceDescriptor: { ...assertSealableArtifactDescriptor(source, source.phaseId) },
      }),
      // The sealed page-evidence descriptor (P5c §2a) — host-derived values
      // from the page the action targets. Same spread discipline for digest
      // stability; may not share a phase with either other evidence kind.
      ...(source.body.pageEvidenceDescriptor === undefined ? {} : {
        pageEvidenceDescriptor: assertSealablePageDescriptor(source, source.phaseId),
      }),
    },
    inputBindings: lowerInputBindings(source.inputBindings),
    outputSchemaDigest: assertPackDigest(canonicalDigest(source.outputSchema)),
    expansion: { kind: "single" },
    bounds: providerPhaseBounds(requirement.requestedBounds, source.bounds),
  };
}

/**
 * The provider input record's own keys. The host writes the path table under
 * the descriptor's key and the SEALED request under these — a descriptor
 * claiming one would land its table where the platform writes the rendered
 * request or its template ref. The byte-level parser refuses them too; this
 * refusal is the one every compile path crosses, typed fixtures included.
 */

/** A descriptor fit to seal: its path-table key collides with nothing the host owns. */
function assertSealableDescriptor(
  descriptor: SourceEvidenceDescriptorV2, phaseId: string,
): SourceEvidenceDescriptorV2 {
  if (RESERVED_PROVIDER_INPUT_KEYS.has(descriptor.pathTableKey)) {
    throw new PackParseError(
      `phase ${phaseId} sourceEvidenceDescriptor.pathTableKey may not take the reserved input key: ${descriptor.pathTableKey}`);
  }
  return descriptor;
}

/** An artifact-evidence descriptor fit to seal: no reserved key, no sibling source-evidence declaration. */
function assertSealableArtifactDescriptor(
  source: PackPhaseV2, phaseId: string,
): ArtifactEvidenceDescriptorV2 {
  const body = source.body as { artifactEvidenceDescriptor?: ArtifactEvidenceDescriptorV2; sourceEvidenceDescriptor?: unknown };
  const descriptor = body.artifactEvidenceDescriptor!;
  if (body.sourceEvidenceDescriptor !== undefined) {
    throw new PackParseError(
      `phase ${phaseId} declares BOTH a sourceEvidenceDescriptor and an artifactEvidenceDescriptor; a phase reads one evidence kind`);
  }
  if (RESERVED_PROVIDER_INPUT_KEYS.has(descriptor.pathTableKey)) {
    throw new PackParseError(
      `phase ${phaseId} artifactEvidenceDescriptor.pathTableKey may not take the reserved input key: ${descriptor.pathTableKey}`);
  }
  return descriptor;
}

/** A page-evidence descriptor fit to seal: alone on its phase, no reserved input ids. */
function assertSealablePageDescriptor(
  source: PackPhaseV2, phaseId: string,
): PageEvidenceDescriptorV2 {
  const body = source.body as {
    pageEvidenceDescriptor?: PageEvidenceDescriptorV2;
    sourceEvidenceDescriptor?: unknown; artifactEvidenceDescriptor?: unknown;
  };
  const descriptor = body.pageEvidenceDescriptor!;
  if (body.sourceEvidenceDescriptor !== undefined || body.artifactEvidenceDescriptor !== undefined) {
    throw new PackParseError(
      `phase ${phaseId} declares a pageEvidenceDescriptor beside another evidence kind; a phase reads one evidence kind`);
  }
  if (RESERVED_PROVIDER_INPUT_KEYS.has(descriptor.pathTableKey)) {
    throw new PackParseError(
      `phase ${phaseId} pageEvidenceDescriptor.pathTableKey may not take the reserved input key: ${descriptor.pathTableKey}`);
  }
  const exposures = flattenPageEvidenceExposures(descriptor.captures);
  for (const capture of exposures) {
    if (RESERVED_PROVIDER_INPUT_KEYS.has(capture.inputId)) {
      throw new PackParseError(
        `phase ${phaseId} page-evidence capture ${capture.captureId} may not take the reserved input id: ${capture.inputId}`);
    }
  }
  const inputIds = exposures.map((exposure) => exposure.inputId);
  if (new Set(inputIds).size !== inputIds.length) {
    throw new PackParseError(
      `phase ${phaseId} page-evidence repeats a materialized inputId; the provider inputs must be pairwise distinct`);
  }
  return descriptor;
}

/** Refuse a common declaration the normalized plan phase cannot represent. */
function assertRepresentable(source: PackPhaseV2): void {
  if (source.missingInputDisposition !== "fail") {
    throw new PackDeferredError("a non fail-closed missing-input disposition has no plan representation");
  }
}

/**
 * Refuse a work body naming a completeness class the recipe never declares.
 *
 * The class string travels verbatim into the execute-time binding, and every
 * downstream consumer — the deficit a validating select records, the required
 * set the materializer refuses on — matches it by EXACT STRING. A typo here
 * ("row-validty") would compile, count its deficits under a class nothing
 * declared, and be ignored at materialization: the silent drop again, one
 * misspelling away. The expansion controls already refuse an undeclared class
 * (deficitDispositionOf); this closes the same door for the body's own field.
 */
function assertDeclaredCompletenessClass(source: WorkPhaseV2, declared: ReadonlySet<string>): void {
  const completenessClass = (source.body as { completenessClass?: unknown }).completenessClass;
  if (typeof completenessClass === "string" && !declared.has(completenessClass)) {
    throw new PackParseError(
      `phase ${source.phaseId} names an undeclared completeness class: ${completenessClass}`);
  }
}

/** Lower one work phase to a host-handler executor bound to its real body. */
function lowerWorkPhase(source: WorkPhaseV2, context: PhaseLoweringContextV1): LoweredPhaseV1 {
  assertDeclaredCompletenessClass(source, context.completenessClasses);
  const family = HOST_HANDLER_FAMILY_BY_PHASE_KIND[source.kind];
  const ref = hostHandlerRefFor(family);
  const { descriptor } = context.resolve(ref);
  const bindings = lowerInputBindings(source.inputBindings);
  return {
    phase: {
      ...commonPhase(source), role: "work",
      executor: {
        kind: "host-handler", handlerId: descriptor.handlerId,
        handlerContractVersion: descriptor.handlerContractVersion,
        handlerContractDigest: descriptor.handlerContractDigest,
      },
      inputBindings: bindings,
      outputSchemaDigest: assertPackDigest(canonicalDigest(source.outputSchema)),
      expansion: lowerExpansion(source, bindings, context.completenessClasses),
      bounds: hostHandlerPhaseBounds(descriptor, source.bounds),
    },
    // TypeScript cannot correlate a family literal with its body type once the
    // union member has been widened, so the pairing is asserted here. It is
    // correct by construction — the family and the body are both selected by
    // THIS phase's own `kind`, from the one lowering table — and the compiler
    // suite pins the pairing for each of the six kinds.
    binding: {
      logicalPhaseId: source.phaseId, family, body: source.body,
      bounds: { maximumItems: source.bounds.maxItems, maximumOutputBytes: source.bounds.maxOutputBytes },
    } as CompiledPhaseBindingV1,
  };
}

/** Lower one gate phase to a closed host gate contract; it runs no executor. */
function lowerGatePhase(
  source: Extract<PackPhaseV2, { kind: "gate" }>, context: PhaseLoweringContextV1,
): NormalizedPhaseV1 {
  const bindings = lowerInputBindings(source.inputBindings);
  return {
    ...commonPhase(source), role: "gate",
    inputBindings: bindings,
    outputSchemaDigest: assertPackDigest(canonicalDigest(source.outputSchema)),
    expansion: lowerExpansion(source, bindings, context.completenessClasses),
    gate: lowerGateContract(source.phaseId, source.body.gateKindId),
    bounds: gatePhaseBounds(),
  };
}

/** The identity, dependency, and disposition fields every role copies through. */
function commonPhase(source: PackPhaseV2): Pick<NormalizedPhaseV1, "logicalPhaseId" | "dependsOn" | "disposition"> {
  return {
    logicalPhaseId: source.phaseId,
    dependsOn: [...source.dependencies],
    disposition: source.disposition,
  };
}

/** Bind one gate phase to one of the eight closed gate kinds, or refuse. */
function lowerGateContract(phaseId: string, gateKindId: string): PhaseGateContractV1 {
  const gateKind = GATE_KINDS.find((kind) => kind === gateKindId);
  if (gateKind === undefined) throw new PackParseError(`gate phase names an unregistered gate kind: ${gateKindId}`);
  return { gateId: phaseId, gateKind };
}

/**
 * Lower the phase's input bindings. An `action-input` binding reads the frozen
 * initial input set; a `phase-output` binding names its producer through the
 * first segment of its dotted reference. Plan graph validation then requires
 * that producer to dominate this phase.
 */
function lowerInputBindings(sources: readonly PhaseInputBindingV2[]): PhaseInputBindingV1[] {
  return sources.map((binding) => {
    if (binding.source === "action-input") return { bindingId: binding.bindingId, sourceKind: "initial-input" };
    if (binding.source === "phase-output") {
      return { bindingId: binding.bindingId, sourceKind: "phase-output", sourcePhaseId: producerOf(binding.ref) };
    }
    throw new PackDeferredError("context-evidence input bindings require the context evidence-class authority");
  });
}

/** The producing phase id of a `<phaseId>.<fieldId>` phase-output reference. */
function producerOf(ref: string): string {
  const separator = ref.indexOf(".");
  return separator === -1 ? ref : ref.slice(0, separator);
}

/** Lower the declared expansion policy, or the implicit single instance. */
function lowerExpansion(
  source: PackPhaseV2, bindings: readonly PhaseInputBindingV1[], completenessClasses: ReadonlySet<string>,
): PhaseExpansionV1 {
  const policy = source.expansionPolicy;
  if (policy === undefined) return { kind: "single" };
  if (policy.kind === "bounded-repeat") {
    throw new PackDeferredError("bounded-repeat expansion requires a continuation rule the recipe grammar omits");
  }
  return {
    kind: "map",
    sourceEvidenceBinding: mapSourceBinding(bindings, source.phaseId),
    maximumItems: policy.maxItems,
    itemIdentity: itemIdentityOf(policy.stableIdentityPolicy),
    duplicateDisposition: duplicateDispositionOf(policy.duplicateDisposition),
    overflowDisposition: deficitDispositionOf(policy, completenessClasses),
  };
}

/** The one phase-output binding a map fans over, or a refusal when ambiguous. */
function mapSourceBinding(bindings: readonly PhaseInputBindingV1[], phaseId: string): string {
  const sources = bindings.filter((binding) => binding.sourceKind === "phase-output");
  if (sources.length !== 1) {
    throw new PackParseError(`map phase ${phaseId} must bind exactly one phase output to fan over`);
  }
  return sources[0]!.bindingId;
}

/** Bind a declared stable-identity policy to a plan item identity, or refuse. */
function itemIdentityOf(policyId: string): "host-id" | "canonical-item-digest" {
  const identity = Object.hasOwn(ITEM_IDENTITY_BY_POLICY, policyId)
    ? ITEM_IDENTITY_BY_POLICY[policyId as keyof typeof ITEM_IDENTITY_BY_POLICY] : undefined;
  if (identity === undefined) throw new PackParseError(`unregistered stable-identity policy: ${policyId}`);
  return identity;
}

/** Bind a declared duplicate disposition to the plan's closed pair, or refuse. */
function duplicateDispositionOf(disposition: ExpansionControlsV2["duplicateDisposition"]): "fail" | "deduplicate" {
  if (disposition === "reject" || disposition === "dedupe") return DUPLICATE_DISPOSITION_BY_SOURCE[disposition];
  throw new PackDeferredError(`the plan grammar has no ${disposition} duplicate disposition`);
}

/** Lower the overflow disposition, requiring a declared completeness class. */
function deficitDispositionOf(
  controls: ExpansionControlsV2, completenessClasses: ReadonlySet<string>,
): ExpansionDeficitDisposition {
  if (controls.overflowDisposition === "fail") return { kind: "fail-closed" };
  if (!completenessClasses.has(controls.completenessClass)) {
    throw new PackParseError(`expansion names an undeclared completeness class: ${controls.completenessClass}`);
  }
  return { kind: "count-as-incomplete", completenessClassId: controls.completenessClass };
}
