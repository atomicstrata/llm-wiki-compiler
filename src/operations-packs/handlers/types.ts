/**
 * @file src/operations-packs/handlers/types.ts
 * @description The closed value objects for the WOP V3 generic host-handler
 * taxonomy (design section 16). It declares the immutable evidence a pure handler
 * family consumes, the bounded output it produces, the visible included/excluded
 * identity set some families expose, the counted completeness deficits, and the
 * six per-family input/output schemas. It also declares the closed
 * {@link RenderTemplateV1} grammar (section 16.5) and the typed Milestone A
 * mutation-DRAFT shape (section 16.7), plus the single fail-closed error every
 * handler and the registry raise.
 *
 * SECURITY BY CONSTRUCTION (sections 10.3, 16.1, 16.5, 16.7). Nothing here can
 * carry executable content. Evidence values are closed scalars; a render template
 * is a CLOSED node union with no expression / path / include / helper arm, so
 * executable interpolation is unrepresentable; an intent draft is a closed typed
 * record with no free-form JSON field and no writable path. The pack bodies these
 * handlers consume are the already-parsed closed shapes from {@link ../recipe-types}
 * — a pack-authored string constant is refused upstream, so a rule/intent constant
 * reaching a handler is a bounded number or boolean, never free-form text.
 *
 * PACK-SCOPED NAMES. Every exported name is `Pack…V1`/`…V1`-scoped and distinct
 * from `src/preparations/` and `src/products/` so the module composes without a
 * duplicate-export collision (fallow Structure).
 */

import type {
  ContextPhaseBodyV2, IntentGroupV2, IntentPhaseBodyV2, PackProjectionV2, ReconcilePhaseBodyV2,
  RenderPhaseBodyV2, SelectPhaseBodyV2, ValidatePhaseBodyV2,
} from "../recipe-types.js";

/** One closed scalar an evidence field or intent draft field may hold. */
export type PackEvidenceScalarV1 = string | number | boolean;

/** One immutable evidence item: a stable host identity plus closed scalar fields. */
export interface PackEvidenceItemV1 {
  readonly itemId: string;
  readonly fields: Readonly<Record<string, PackEvidenceScalarV1>>;
}

/** The finite item and output-byte ceilings every family enforces (section 16.1). */
export interface PackHandlerBoundsV1 {
  readonly maximumItems: number;
  readonly maximumOutputBytes: number;
}

/**
 * One item a family excluded, with a fixed reason code (never caller free text).
 *
 * `invalid-value` is DISTINCT from `filtered-out` on purpose: it marks a row the
 * parameterised `one-of` admission predicate refused — a malformed row, not one
 * a routing predicate intentionally dropped — so the validation deficit can
 * always count it without a fan-out split's routine exclusions coming with it.
 * The parameterless family still shares the single `filtered-out` reason, so it
 * has no such separation; only `one-of` carries its own.
 */
export interface PackExclusionV1 {
  readonly itemId: string;
  readonly reason:
    | "ineligible-class" | "ineligible-tier" | "over-item-budget"
    | "over-byte-budget" | "over-token-budget" | "duplicate-identity"
    | "filtered-out" | "invalid-value" | "not-in-secondary" | "in-secondary" | "over-top-n";
}

/** The visible included/excluded identity set a selecting family declares (16.2/16.3). */
export interface PackHandlerSelectionV1 {
  readonly included: readonly string[];
  readonly excluded: readonly PackExclusionV1[];
}

/** One counted completeness deficit under a declared class (section 15.3). */
export interface PackCompletenessDeficitV1 {
  readonly completenessClass: string;
  readonly reason: "overflow" | "non-convergence" | "suppressed-finding" | "invalid-row";
  readonly droppedCount: number;
}

/** The closed host-derived identities an intent mapping may bind (section 16.7). */
export interface PackHostIdentitiesV1 {
  readonly runId: string;
  readonly principal: string;
  readonly hostTimestamp: string;
}

/** The injected host clock rule-evaluate reads for freshness windows (16.4). */
export interface PackHostClockV1 {
  now(): string;
}

// --- 16.2 context-assemble -------------------------------------------------

/** The bounded, immutable input one context-assemble invocation consumes. */
export interface PackContextInputV1 {
  readonly body: ContextPhaseBodyV2;
  readonly evidence: readonly PackEvidenceItemV1[];
  readonly bounds: PackHandlerBoundsV1;
}

/** One item admitted into the assembled context, in stable order. */
export interface PackContextItemV1 {
  readonly itemId: string;
  readonly evidenceClass: string;
  readonly contentTier: string;
}

/** The bounded output evidence context-assemble produces (section 16.2). */
export interface PackContextResultV1 {
  readonly eligibilityPolicyId: string;
  readonly orderingPolicyId: string;
  readonly items: readonly PackContextItemV1[];
  readonly itemCount: number;
  readonly byteCount: number;
  readonly tokenCount: number;
  readonly selection: PackHandlerSelectionV1;
  readonly deficits: readonly PackCompletenessDeficitV1[];
}

// --- 16.3 set-select -------------------------------------------------------

/** The closed set operation a set-select body selects (section 16.3). */
export type PackSelectOperationV1 = SelectPhaseBodyV2["operation"];

/** The primary and optional secondary evidence a set operation compares. */
export interface PackSelectInputV1 {
  readonly body: SelectPhaseBodyV2;
  readonly primary: readonly PackEvidenceItemV1[];
  readonly secondary?: readonly PackEvidenceItemV1[];
  readonly bounds: PackHandlerBoundsV1;
}

/** One partition a group-by operation produced, keyed by the declared scalar. */
export interface PackSelectGroupV1 {
  readonly key: string;
  readonly itemIds: readonly string[];
}

/** The bounded output evidence set-select produces (section 16.3). */
export interface PackSelectResultV1 {
  readonly operation: PackSelectOperationV1;
  readonly items: readonly PackEvidenceItemV1[];
  readonly groups?: readonly PackSelectGroupV1[];
  readonly selection: PackHandlerSelectionV1;
  readonly deficits: readonly PackCompletenessDeficitV1[];
}

// --- 16.4 rule-evaluate ----------------------------------------------------

/** The bounded typed evidence rule-evaluate applies registered rules to (16.4). */
export interface PackRuleInputV1 {
  readonly body: ValidatePhaseBodyV2;
  readonly evidence: readonly PackEvidenceItemV1[];
  readonly clock: PackHostClockV1;
  readonly bounds: PackHandlerBoundsV1;
}

/** One deterministic finding a registered rule produced, in stable order. */
export interface PackRuleFindingV1 {
  readonly ruleId: string;
  readonly code: string;
  readonly itemId?: string;
}

/** The bounded output evidence rule-evaluate produces (section 16.4). */
export interface PackRuleResultV1 {
  readonly evaluatedRuleIds: readonly string[];
  readonly findings: readonly PackRuleFindingV1[];
  readonly deficits: readonly PackCompletenessDeficitV1[];
}

// --- 16.5 render-template --------------------------------------------------

/**
 * One node of the closed {@link RenderTemplateV1} grammar (section 16.5). The
 * union has NO expression, path, include, helper, or shell arm: literal segments
 * are inert host-authored text, and every evidence field insertion names a
 * declared field id and a registered escaping policy, so no executable
 * interpolation is representable.
 */
export type PackRenderNodeV1 =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "field"; readonly field: string; readonly escaping: string }
  | { readonly kind: "each"; readonly body: readonly PackRenderNodeV1[] }
  | { readonly kind: "when-present"; readonly field: string; readonly body: readonly PackRenderNodeV1[] };

/** A registered closed render template resolved by a render body's templateRef. */
export interface RenderTemplateV1 {
  readonly templateId: string;
  readonly version: string;
  readonly nodes: readonly PackRenderNodeV1[];
}

/** The template, top-level frame, and iterable items one render consumes (16.5). */
export interface PackRenderInputV1 {
  readonly body: RenderPhaseBodyV2;
  readonly template: RenderTemplateV1;
  readonly frame: Readonly<Record<string, PackEvidenceScalarV1>>;
  readonly items: readonly PackEvidenceItemV1[];
  readonly bounds: PackHandlerBoundsV1;
}

/** The bounded output evidence render-template produces (section 16.5). */
export interface PackRenderResultV1 {
  readonly templateRef: string;
  readonly formatId: string;
  readonly output: string;
  readonly byteCount: number;
  readonly deficits: readonly PackCompletenessDeficitV1[];
}

// --- 16.6 reconcile --------------------------------------------------------

/** One of the nine closed reconcile finding classes (section 16.6). */
export type PackReconcileFindingClassV1 = ReconcilePhaseBodyV2["findingClasses"][number];

/** The proposed evidence and current snapshot reconcile compares (section 16.6). */
export interface PackReconcileInputV1 {
  readonly body: ReconcilePhaseBodyV2;
  readonly proposed: readonly PackEvidenceItemV1[];
  readonly snapshot: readonly PackEvidenceItemV1[];
  readonly bounds: PackHandlerBoundsV1;
  /**
   * The canonical projection the body's `projectionRef` named, resolved by the
   * runtime. Applied to proposals BEFORE comparison so the two sides speak the
   * same vocabulary — see handlers/projection.ts.
   */
  readonly projection?: PackProjectionV2;
}

/** One reconcile finding: a proposed identity and its closed finding class. */
export interface PackReconcileFindingV1 {
  readonly identity: string;
  readonly findingClass: PackReconcileFindingClassV1;
}

/** The bounded output evidence reconcile produces; it never writes (16.6). */
export interface PackReconcileResultV1 {
  readonly reconcilePolicyId: string;
  readonly comparedEvidenceClass: string;
  readonly findings: readonly PackReconcileFindingV1[];
  /**
   * The findings as CHAINABLE evidence — one item per finding, carrying the
   * proposal's own fields with `findingClass` stamped beside them. `findings` is
   * the report; this is what a successor phase receives, so a proposing terminal
   * can disposition by the verdict instead of proposing over it.
   */
  readonly items: readonly PackEvidenceItemV1[];
  readonly deficits: readonly PackCompletenessDeficitV1[];
}

// --- 16.7 intent-compile ---------------------------------------------------

/** One closed Milestone A mutation kind an intent phase may propose (16.7). */
export type PackIntentMutationKindV1 = IntentGroupV2["mutationKind"];

/** The proposal evidence and host identities one intent-compile consumes (16.7). */
export interface PackIntentInputV1 {
  readonly body: IntentPhaseBodyV2;
  readonly evidence: readonly PackEvidenceItemV1[];
  readonly identities: PackHostIdentitiesV1;
  readonly bounds: PackHandlerBoundsV1;
  /** The compiled action's projections, for groups that name one. */
  readonly projections?: Readonly<Record<string, PackProjectionV2>>;
}

/** One typed Milestone A mutation DRAFT; a proposal only, never a direct write. */
export interface PackIntentDraftV1 {
  readonly sourceItemId: string;
  readonly mutationKind: PackIntentMutationKindV1;
  readonly targetProfileClass: string;
  readonly fields: Readonly<Record<string, PackEvidenceScalarV1>>;
  /** Fields the page-payload formatter emits as one-element lists (group-declared). */
  readonly listFields?: readonly string[];
  /**
   * For an `artifact-update`: the digest and size of the page bytes this draft
   * was computed against, carried from the reconcile snapshot.
   *
   * IT IS WHAT MAKES A STALE UPDATE PARK INSTEAD OF OVERWRITE. Proposal and
   * apply are separated in time; without this the update would clobber whatever
   * the page had become in between, silently overriding the review.
   */
  readonly expectedCurrent?: { readonly digest: string; readonly byteCount: number };
  readonly payloadDigest: string;
}

/** The Orchestration V2 handoff-capacity envelope intent-compile computes (16.7). */
export interface PackHandoffCapacityV1 {
  readonly maximumDrafts: number;
  readonly declaredDrafts: number;
  readonly maximumPayloadBytes: number;
}

/** The bounded output evidence intent-compile produces; no direct writes (16.7). */
export interface PackIntentResultV1 {
  readonly intentTemplateRef: string;
  readonly drafts: readonly PackIntentDraftV1[];
  readonly handoffCapacity: PackHandoffCapacityV1;
  readonly deficits: readonly PackCompletenessDeficitV1[];
}

/**
 * The single fail-closed refusal every handler family and the registry raise: an
 * unknown handler id, a drifted contract digest, a wrong version, a bounds
 * overflow under a fail-closed disposition, an unregistered rule/format/escaping
 * id, or a missing bound input. A rejected caller value never enters the message.
 */
export class PackHostHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackHostHandlerError";
  }
}
