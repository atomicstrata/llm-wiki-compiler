/**
 * @file src/operations-packs/types.ts
 * @description Closed, data-only value objects for the WOP V3 operations-pack
 * contract (design sections 10, 11, 13, 14, 15, 19). These records describe
 * authoring intent but expose no callbacks, executable adapters, credentials, or
 * writable paths; every digest reuses the repository's branded
 * {@link Sha256Digest}. Types the v3 spec defines only in prose are resolved to
 * concrete closed shapes here and each such resolution is annotated. The FULL
 * recipe authoring sub-grammar (sections 15.1-15.4, 16) — the input/output/bounds
 * contracts, completeness sources, and one closed source body per phase kind —
 * lives in {@link ./recipe-types} and is re-exported here for one import surface.
 *
 * NAME COLLISION: the product-package module's `PackExperienceSurfaceV1` is an object
 * ({ surfaceId, interactionResourceDigest }); the operations-pack spec (section
 * 14.1) defines `PackExperienceSurfaceV1` as a string union. This module uses the
 * operations-pack string-union definition and never imports the product one.
 */

import type { PackProjectionV2 } from "./recipe-types.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import type { CapabilityClass } from "../profile/types.js";
import type { RenderTemplateV1 } from "./handlers/types.js";
import type { PackRecipeV2 } from "./recipe-types.js";

export type { Sha256Digest } from "../capability-providers/types.js";
export type { CapabilityClass } from "../profile/types.js";

/** The four transports that carry real capability and principal authority (14.1). */
export type InvocationSurfaceV1 = "cli" | "sdk" | "mcp" | "viewer";

/** Experience surfaces: the four transports plus the non-authoritative agent (14.1). */
export type PackExperienceSurfaceV1 = InvocationSurfaceV1 | "agent";

/**
 * RESOLVED (section 10.2 is prose): the exact contract pins a pack was authored
 * against. Design-document digests are compatibility evidence, not code imports.
 */
export interface PackContractRequirementsV2 {
  providerContractDigest: Sha256Digest;
  orchestrationContractDigest: Sha256Digest;
  milestoneAContractDigest: Sha256Digest;
  knowledgeProfileSchemaVersion: number;
  operationsPackSchemaVersion: number;
  hostHandlerRegistryVersion: string;
  hostHandlerRegistryDigest: Sha256Digest;
}

/** The explicit fallback policy of one provider requirement (section 13.1). */
export type ProviderFallbackPolicyV2 =
  | { kind: "none" }
  | { kind: "explicit-ordered"; providerPinDigests: Sha256Digest[] };

/** One provider capability role a pack requires (section 13.1, FULL shape). */
export interface ProviderRequirementV2 {
  roleId: string;
  disposition: "required" | "optional";
  capabilityId: string;
  capabilityContractDigest: Sha256Digest;
  allowedProviderPins: Sha256Digest[];
  defaultProviderPin?: Sha256Digest;
  requiredReadinessDimensions: string[];
  requestedGrantKinds: string[];
  fallbackPolicy: ProviderFallbackPolicyV2;
  /**
   * The per-attempt envelope this role REQUESTS, sealed into the plan digest.
   *
   * THE PACK REQUESTS; THE OPERATOR'S GRANT STILL DECIDES — the same shape
   * `requestedGrantKinds` already uses, and the reason a pack declaring its own
   * ceilings is not granting itself budget. Sealing the request means approving
   * a plan is approving THAT ceiling and no larger; the grant caps
   * independently at invocation, so the effective bound is the smaller of the
   * two and neither authority can be bypassed by the other.
   *
   * Absent for a role whose phases never run — every host-handler phase pins
   * these to zero, and a provider phase without a declared request is refused
   * rather than lowered to an unbounded one.
   */
  requestedBounds?: ProviderRequestedBoundsV2;
}

/** One provider role's requested per-attempt ceilings (all required together). */
export interface ProviderRequestedBoundsV2 {
  maxBrokerRequestsPerAttempt: number;
  maxTokensPerAttempt: number;
  maxCostMicrosPerAttempt: number;
  maxWallTimeMsPerAttempt: number;
}

/**
 * RESOLVED (section 12.1 is prose): the workspace contract's nine declared
 * dimensions as concrete closed fields. It names opaque host policy ids and role
 * ids, never arbitrary paths, and grants no provider access to any root.
 */
export interface WorkspaceContractV2 {
  workspaceIdentityGrammar: string;
  requiredKnowledgeProfileId: string;
  compatibleKnowledgeProfileDigests: Sha256Digest[];
  catalogSchemaDependencies: string[];
  sourceSchemaDependencies: string[];
  allowedContextRootPolicyIds: string[];
  declaredProjectionClasses: string[];
  requiredSettingFields: string[];
  requiredProviderCapabilityRoles: string[];
  supportedImportCompatibilityModes: string[];
  productReadinessDimensions: ProductReadinessDimensionV2[];
}

/**
 * One OPTIONAL capability a product declares, and everything a readiness review
 * needs to describe it without the host knowing what the product is.
 *
 * A BARE SLUG WAS NOT ENOUGH, and that is why this shape exists. The field used
 * to be a list of ids that nothing read: an author could declare readiness
 * dimensions and no surface reported them. A review must say what a capability
 * AFFECTS, what DEGRADES without it, and how to turn it on — none of which a
 * slug carries — so each dimension names its own credential slot and its own
 * description keys.
 *
 * `credentialSlotId` is the readiness test and the configuration answer: a
 * handle bound to that slot is what the review looks for, and "how do I enable
 * this" is answered by naming it.
 *
 * EVERY DESCRIPTIVE MEMBER IS OPTIONAL, because the field previously held bare
 * slugs and an INSTALLED PACKAGE MUST NOT BECOME UNPARSEABLE when the host
 * upgrades. A store ecosystem where a core release silently bricks published
 * packages is not one anyone can publish into. A legacy `"model-ready"` string
 * therefore still parses — as a dimension that names itself and declares no way
 * to check itself, which the review reports as `undeclared` rather than
 * pretending to know.
 */
export interface ProductReadinessDimensionV2 {
  dimensionId: string;
  credentialSlotId?: string;
  /** What this capability affects when it IS available. */
  summaryKey?: string;
  /** What degrades when it is not — the honest cost of skipping it. */
  degradedSummaryKey?: string;
}

/** RESOLVED (section 14.2 prose): the sensitivity-display class of an input field. */
export type InputSensitivityClassV2 = "normal" | "sensitive";

/**
 * RESOLVED (no v3 interface): a concrete default or alias input value. Deep
 * validation against the field schema is the input resolver's job (14.3, 19.2),
 * so at parse time a value is a bounded scalar or a bounded list of scalars.
 */
export type PackActionInputScalarV2 = string | number | boolean;
export type PackActionInputValueV2 = PackActionInputScalarV2 | readonly PackActionInputScalarV2[];

/** Fields every input-field kind declares (section 14.2). */
export interface InputFieldCommonV2 {
  required: boolean;
  overridable: boolean;
  sensitivityDisplay: InputSensitivityClassV2;
  guidedPresentationKey?: string;
  default?: PackActionInputValueV2;
}

/** The kind-specific portion of one input field (the 13 closed arms, section 14.2). */
export type PackActionInputKindV2 =
  | { kind: "string"; maxBytes: number; patternId?: string }
  | { kind: "string-list"; maxItems: number; maxItemBytes: number }
  | { kind: "boolean" }
  | { kind: "integer"; minimum: number; maximum: number }
  | { kind: "number"; minimum: number; maximum: number }
  | { kind: "enum"; values: string[] }
  | { kind: "entity-ref"; allowedEntityTypes: string[] }
  | { kind: "artifact-ref"; allowedArtifactTypes: string[] }
  | { kind: "source-ref" }
  | { kind: "caller-file"; inputPolicyId: string }
  | { kind: "uri"; allowedSchemes: string[]; maxBytes: number }
  | { kind: "provider-role"; roleId: string }
  | { kind: "output-format"; formatId: string };

/** The closed 13-kind tagged input-field union (section 14.2, FULL). */
export type PackActionInputFieldV2 = InputFieldCommonV2 & PackActionInputKindV2;

/**
 * RESOLVED (no v3 interface; sections 12.3, 21, WOP-INV-24): a pack may request a
 * confirmation floor at or above the host baseline and may request a post-result
 * confirmation, but can never lower host severity. The host owns confirmation
 * facts; this policy only narrows or adds.
 */
export type ConfirmationSeverityFloorV1 = "host-required" | "always-confirm";
export interface ConfirmationPolicyV1 {
  severityFloor: ConfirmationSeverityFloorV1;
  requestPostResultConfirmation: boolean;
}

/**
 * DEFERRED (settings authority): action-to-setting bindings. The parser refuses
 * any pack that declares an action setting binding; the shape is opaque here so
 * no reduced binding can masquerade as validated.
 */
export type ActionSettingBindingV1 = { readonly deferred: true };

/**
 * DEFERRED (alias-deprecation grammar is under-specified in v3): the parser
 * refuses any alias that declares a deprecation notice.
 */
export type AliasDeprecationV1 = { readonly deferred: true };

/** How a preparation or configuration action executes (section 14.1, FULL). */
export type PackActionExecutionV2 =
  | {
      kind: "preparation";
      executionMode: "ephemeral-read" | "durable-preparation";
      recipeRef: string;
      outputContractRef: string;
    }
  | { kind: "configuration"; flowRef: string };

/** One product action (section 14.1, FULL shape). */
export interface PackActionV2 {
  actionId: string;
  actionVersion: string;
  labelKey: string;
  summaryKey: string;
  execution: PackActionExecutionV2;
  inputSchema: Record<string, PackActionInputFieldV2>;
  requestedSurfaceCaps: Partial<Record<InvocationSurfaceV1, CapabilityClass>>;
  requiredGates?: string[];
  confirmationPolicy: ConfirmationPolicyV1;
  readinessRuleRefs?: string[];
  settingBindings?: ActionSettingBindingV1[];
  compatibilityTags?: string[];
}

/**
 * The FULL recipe authoring grammar (sections 15.1-15.4, 16) is defined once in
 * {@link ./recipe-types}; consumers import those shapes directly from that module.
 * Only {@link PackRecipeV2} is imported here — it is the value the pack root holds
 * in {@link WorkspaceOperationsPackV2.recipes}.
 */

/** One alias mapping a familiar invocation to one canonical action (section 19.1). */
export interface AliasDescriptorV1 {
  aliasId: string;
  surface: PackExperienceSurfaceV1;
  transportSurface?: InvocationSurfaceV1;
  host?: string;
  locale?: string;
  token: string;
  actionId: string;
  defaultInputs?: Record<string, PackActionInputValueV2>;
  deprecation?: AliasDeprecationV1;
}

/**
 * One immutable, single-root operations pack (section 10.1). Deferred declarative
 * collections (imports, settingSchema, and the remaining optional record kinds)
 * are KNOWN field names so an unknown field still fails closed distinctly, but a
 * non-empty deferred collection is refused rather than under-parsed.
 * `renderTemplates` is PROMOTED out of that deferral: a pack ships the closed
 * declarative templates its render phases name, parsed through their own closed
 * node grammar and covered by the root pack digest like every other member.
 */
export interface WorkspaceOperationsPackV2 {
  schemaVersion: 2;
  packId: string;
  packVersion: string;
  displayName: string;
  minLlmwikiVersion: string;
  requires: PackContractRequirementsV2;
  providerRequirements: ProviderRequirementV2[];
  workspaceContract: WorkspaceContractV2;
  recipes: Record<string, PackRecipeV2>;
  actions: Record<string, PackActionV2>;
  aliases?: AliasDescriptorV1[];
  renderTemplates?: Record<string, RenderTemplateV1>;
  /**
   * Canonical projections, shared by the phases that COMPARE and the phases
   * that WRITE so one field mapping serves both. Pack-level, like
   * `renderTemplates`, because two phases in different recipes may name the
   * same projection and a per-phase copy is the drift this removes.
   */
  projections?: Record<string, PackProjectionV2>;
}

/** One resolved export row in the flattened composition table (section 11.2). */
export interface ResolvedExportV1 {
  kind: "provider-requirement" | "recipe" | "action" | "alias";
  exposedId: string;
  sourcePackDigest: Sha256Digest;
  sourceId: string;
  objectDigest: Sha256Digest;
}

/** One composition member row (section 11.2). Single-root packs have one member. */
export interface CompositionMemberV1 {
  packId: string;
  packVersion: string;
  packDigest: Sha256Digest;
  memberDigest: Sha256Digest;
}

/** The independently recomputable composition lock (section 11.2). */
export interface CompositionLockV1 {
  schemaVersion: 1;
  rootPackDigest: Sha256Digest;
  members: CompositionMemberV1[];
  resolvedExports: ResolvedExportV1[];
  graphDigest: Sha256Digest;
}

/** The composed single-root graph: its root pack and flattened export table. */
export interface ComposedGraphV1 {
  rootPackDigest: Sha256Digest;
  members: CompositionMemberV1[];
  resolvedExports: ResolvedExportV1[];
}
