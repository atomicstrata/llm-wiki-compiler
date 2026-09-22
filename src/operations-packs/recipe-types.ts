/**
 * @file src/operations-packs/recipe-types.ts
 * @description The FULL closed recipe authoring grammar for WOP V3 (design
 * sections 15.1-15.4 and 16.1-16.9). Every type here is pure declarative data:
 * the recipe input/output/bounds contracts, the completeness sources, the common
 * per-phase declaration, and one kind-specific closed source body per phase kind.
 *
 * SECURITY BY CONSTRUCTION (section 10.3 / 16.1 / 16.5 / 16.7). None of these
 * shapes can carry section-10.3 forbidden content. Each phase body field is only
 * one of: a registered id under a closed grammar (rule-id, template-id,
 * policy-id, format-id — validated as a slug or dotted `ref-id`, so `/etc/passwd`,
 * `rm -rf /`, `eval(x)`, and `../../x` are all unrepresentable), a closed enum
 * discriminant, a bounded scalar or bounded list of scalars, or a typed reference
 * to another declared object (a phase id, an evidence class, a provider role).
 * There is deliberately NO free-form string, NO arbitrary-JSON field, NO template
 * body, NO filesystem path, NO comparator/expression language, and NO generic
 * host-handler id (section 16.1): each phase `kind` selects exactly one registered
 * host-handler family, and its body only supplies that family's declarative
 * parameters. Loosening any body field to accept free-form text (e.g. an inline
 * template string or an arbitrary-JSON parameter bag) would reintroduce that risk,
 * which the negative sweep pins.
 *
 * RESOLVED-FROM-PROSE DESIGN DECISIONS. Sections 16.2-16.9 are prose, not TS
 * interfaces, so each body below is a faithful minimal-but-complete closed record:
 *   - provider (15.2): a single declared provider-requirement role reference; the
 *     exact pin/grant/effect authority stays with Provider V2.
 *   - context (16.2): a registered eligibility policy id, bounded progressive
 *     content tiers, referenced evidence classes, and deterministic item/byte/
 *     token budgets under a registered ordering policy — never a raw path.
 *   - select (16.3): a closed set-operation discriminant over declared identity
 *     and sort FIELDS and registered filter-predicate ids, with an explicit
 *     overflow disposition and completeness class — never an inline comparator.
 *   - validate (16.4): registered rule-id + version bindings whose parameters are
 *     closed scalar (paramId, value) pairs only — never a new algorithm.
 *   - render (16.5): a registered template-id + registered format-id + named
 *     escaping-policy id over declared evidence refs — never an inline template
 *     with executable interpolation.
 *   - reconcile (16.6): a registered reconcile-policy id over one compared
 *     evidence class emitting only the nine closed finding classes; never writes.
 *   - intent (16.7): a registered intent-template-id, one closed Milestone A
 *     mutation kind, a target profile class, and closed field mappings that only
 *     select a phase input, a bounded constant, or a host-derived identity — never
 *     a concatenated writable path, a provider call, or arbitrary mutation JSON.
 *   - join (16.8): a registered Orchestration V2 join variant with an optional key
 *     field / format id list; lowered to an orchestration join phase.
 *   - gate (15.4): a registered Orchestration V2 gate-kind id; a pack may request
 *     an added gate but can never omit a host/provider/orchestration gate.
 *
 * EXPORT SURFACE. Only the shapes a parser imports by name are exported; the
 * closed enum aliases that appear solely inside these interfaces stay module-local
 * so this file exposes no dead public type (fallow-clean).
 */

/** The three atomicity classes a recipe declares (section 15.1). */
type RecipeAtomicityClassV2 =
  | "local-bundle-only"
  | "external-effect-only"
  | "non-atomic-external-before-local";

/** The nine closed pack-phase kinds (section 15.2). No arbitrary handler id. */
export type PackPhaseKindV2 =
  | "provider" | "context" | "select" | "validate"
  | "render" | "reconcile" | "intent" | "join" | "gate";

/** The closed declarative value kinds a contract or output field may declare. */
type RecipeValueKindV2 =
  | "string" | "string-list" | "boolean" | "integer" | "number"
  | "enum" | "entity-ref" | "artifact-ref" | "source-ref" | "evidence-ref";

/** One declared contract field: a stable id, a closed value kind, and disposition. */
export interface RecipeContractFieldV2 {
  fieldId: string;
  valueKind: RecipeValueKindV2;
  required: boolean;
}

/** The recipe's declared input contract (section 15.1). */
export interface RecipeInputContractV2 {
  fields: RecipeContractFieldV2[];
}

/** The recipe's declared output contract source (section 15.1). */
export interface RecipeOutputContractSourceV2 {
  evidenceClass: string;
  fields: RecipeContractFieldV2[];
  formatIds: string[];
}

/** The recipe's finite scalar bounds source (sections 15.3, 17). */
export interface RecipeBoundsSourceV2 {
  maxPhaseInvocations: number;
  maxTotalItems: number;
  maxOutputBytes: number;
}

/** How one counted completeness deficit is dispositioned (section 15.3). */
type CompletenessDispositionV2 = "required-complete" | "best-effort" | "optional";

/** One completeness class source row for counted deficits (section 15.3). */
export interface CompletenessClassSourceV2 {
  classId: string;
  disposition: CompletenessDispositionV2;
}

/** The disposition when a bound phase input is absent (section 15.2). */
type MissingInputDispositionV2 = "fail" | "skip-phase" | "treat-as-empty";

/** Where one phase input binding draws its value from (section 15.2). */
type PhaseBindingSourceV2 = "action-input" | "phase-output" | "context-evidence";

/** One phase input binding: a stable id, a closed source, and a typed reference. */
export interface PhaseInputBindingV2 {
  bindingId: string;
  source: PhaseBindingSourceV2;
  ref: string;
}

/** One declared phase output field (section 15.2). */
export interface PhaseOutputFieldV2 {
  fieldId: string;
  valueKind: RecipeValueKindV2;
}

/** One phase's finite scalar bounds (section 15.2). */
export interface PhaseBoundsSourceV2 {
  maxItems: number;
  maxOutputBytes: number;
}

/** How duplicate expanded items are dispositioned (section 15.3). */
type DuplicateDispositionV2 = "reject" | "dedupe" | "keep-first" | "keep-last";

/** How an over-cap or non-converging expansion is dispositioned (section 15.3). */
type ExpansionDeficitDispositionV2 = "fail" | "record-deficit";

/** The shared expansion controls both map and bounded-repeat declare (section 15.3). */
export interface ExpansionControlsV2 {
  duplicateDisposition: DuplicateDispositionV2;
  overflowDisposition: ExpansionDeficitDispositionV2;
  nonConvergenceDisposition: ExpansionDeficitDispositionV2;
  completenessClass: string;
  stableIdentityPolicy: string;
}

/** The map or bounded-repeat expansion policy (section 15.3). */
export type PhaseExpansionPolicyV2 =
  | ({ kind: "map"; maxItems: number } & ExpansionControlsV2)
  | ({ kind: "bounded-repeat"; maxIterations: number } & ExpansionControlsV2);

/** The declaration fields every phase carries regardless of kind (section 15.2). */
interface PhaseCommonV2 {
  phaseId: string;
  dependencies: string[];
  disposition: "required" | "optional";
  inputBindings: PhaseInputBindingV2[];
  outputSchema: PhaseOutputFieldV2[];
  bounds: PhaseBoundsSourceV2;
  missingInputDisposition: MissingInputDispositionV2;
  expansionPolicy?: PhaseExpansionPolicyV2;
}

/** provider phase body: one declared provider-requirement role (section 15.2). */
/**
 * The plan-sealed source-evidence descriptor (spec §2.1 generic change 1): how
 * a provider phase reaches retained project sources, named as PACK DATA so the
 * platform never learns a product's field names.
 *
 * A normalized binding records only `{bindingId, sourceKind}` — its field refs
 * are discarded at lowering — so the three initial-input columns carrying the
 * host-resolved rows cannot be recovered from the plan. This descriptor names
 * them, plus the metadata `ProviderInputSpecV1` requires and the caps the plan
 * digest must carry. It lowers onto the provider-capability EXECUTOR beside
 * `requestTemplateRef`: the two together are the complete sealed statement of
 * what a provider may read and what it is asked.
 *
 * CALLERS SUPPLY PATHS ONLY. The host computes the digest and byte-count
 * columns itself and overwrites or refuses supplied values — a caller-supplied
 * digest is an assertion about bytes the caller does not own, and accepting one
 * would defeat the run-time drift check exactly when it matters.
 */
/**
 * Provider-exposure metadata every page-evidence capture materializes with
 * (P5c §2a): the captured bytes reach the provider as ONE input file carrying
 * these attributes, exactly as the source/artifact evidence rows do.
 */
export interface PageEvidenceExposureV2 {
  /** The provider-input id (unique within the action's materialized inputs). */
  inputId: string;
  /** The `ProviderInputSpecV1.kind` the input materializes as. */
  kind: string;
  /** The provenance label shown for this input. */
  provenanceLabel: string;
  /** Media type of the materialized bytes. */
  mediaType: string;
  /** Sealed byte cap — part of the plan digest, never a runtime opinion. */
  maxBytes: number;
}

/** A scalar field capture on some page (the base of two forms). */
export interface PageFieldCaptureV2 extends PageEvidenceExposureV2 {
  form: "page-field";
  /** Slug id; owns the derived sealed-key namespace `<captureId>-*`. */
  captureId: string;
  /** The profile-declared scalar frontmatter field to read. */
  field: string;
}

/** Dereference a hash-pinned single-body artifact named by a page field. */
export interface ArtifactDerefCaptureV2 extends PageEvidenceExposureV2 {
  form: "artifact-deref";
  captureId: string;
  /** The page field holding the FULL canonical `type/slug@sha256:<hex>` ref. */
  refField: string;
  /** The artifact type the ref must name (single-body, never member-bearing). */
  artifactType: string;
}

/** Exact-one outgoing relation traversal, then field captures on the target. */
export interface RelationTargetCaptureV2 {
  form: "relation-target";
  captureId: string;
  /** The declared relation type; traversal is outgoing (`from`) only. */
  relationType: string;
  sourceRole: "from";
  /** The exact entity type the single target must belong to. */
  targetEntityType: string;
  /** Field captures evaluated ON THE TARGET page. */
  then: PageFieldCaptureV2[];
}

/** Authenticate a preparation run and capture its frozen fields + outputs. */
export interface RunBindingCaptureV2 {
  form: "run-binding";
  captureId: string;
  /** The action-input field carrying the run id to authenticate. */
  runIdFrom: string;
  expect: {
    /** The exact action the run must belong to. */
    actionId: string;
    state: "succeeded";
    /** The sealed-input field that must equal the descriptor target's slug. */
    slugField: string;
  };
  /** Sealed-input fields copied out of the authenticated run. */
  frozenFields: Array<PageEvidenceExposureV2 & { captureId: string; field: string }>;
  /**
   * Run outputs selected by PERSISTED names: a unique succeeded
   * `logicalPhaseId`; the selected ref's digest must equal that summary's
   * `outputEvidenceDigest` and its kind/provenance the declared REF fields —
   * distinct from the exposure fields, which describe the MATERIALIZED input
   * (one value serving both roles made the grant's input-kind allowlist
   * collide with the evidence store's ref taxonomy).
   */
  outputs: Array<PageEvidenceExposureV2 & {
    captureId: string; logicalPhaseId: string;
    refKind: string; refProvenanceLabel: string;
  }>;
}

/** One page-evidence capture (P5c §2a): exactly four forms, no fifth. */
export type PageEvidenceCaptureV2 =
  | PageFieldCaptureV2 | ArtifactDerefCaptureV2 | RelationTargetCaptureV2 | RunBindingCaptureV2;

/**
 * A provider phase's sealed PAGE-EVIDENCE declaration (P5c §2a / amended
 * P5COMMON §8): host-DERIVED values from the page the action targets — never
 * caller input. Capture verifies and seals digest+byte-count (and the scalar
 * value when it fits); the runtime reopens every source and re-verifies
 * before the provider phase. Structural vocabulary only; no product terms.
 */
export interface PageEvidenceDescriptorV2 {
  /** The invocation-input key the inputId→captureId table lands under. */
  pathTableKey: string;
  target: {
    /** The profile entity type of the targeted page. */
    entityType: string;
    /** The action-input field carrying the target page's slug. */
    slugField: string;
  };
  captures: PageEvidenceCaptureV2[];
}

/**
 * A provider phase's sealed ARTIFACT-EVIDENCE declaration (AS-4 P4.2, D41a):
 * the phase reads the MEMBERS of one hash-pinned, member-bearing artifact.
 * The ref and the three member columns live in the frozen action input — the
 * ref derived and VERIFIED by the consumer's capture, the columns host-computed
 * from the verified manifest (never trusted from a caller) — and the runtime
 * builder re-verifies health, manifest equality, and every member's bytes at
 * leg time. Structural vocabulary only; no product terms.
 */
export interface ArtifactEvidenceDescriptorV2 {
  /** The initial-input field carrying the pinned `type/slug@sha256:<hex>` ref. */
  refField: string;
  /** The host-computed member-name column; index-aligned. */
  memberNamesField: string;
  /** The host-computed member sha256 column; index-aligned. */
  memberDigestsField: string;
  /** The host-computed member byte-count column; index-aligned. */
  memberByteCountsField: string;
  /** Prefix for each row's generated `inputId`. */
  inputIdPrefix: string;
  /** The `ProviderInputSpecV1.kind` these inputs materialize as. */
  kind: string;
  /** The provenance label shown for these inputs. */
  provenanceLabel: string;
  /** Media type of the materialized bytes. */
  mediaType: string;
  /** Sealed caps — part of the plan digest, never a runtime opinion. */
  maxItems: number;
  maxBytes: number;
  /** The provider-input key the inputId→member-name table lands under. */
  pathTableKey: string;
}

export interface SourceEvidenceDescriptorV2 {
  /** The initial-input field carrying relative paths under `sources/`. */
  pathsField: string;
  /** The host-computed sha256 column; index-aligned with the paths. */
  digestsField: string;
  /** The host-computed byte-count column; index-aligned with the paths. */
  byteCountsField: string;
  /** Prefix for each row's generated `inputId`. */
  inputIdPrefix: string;
  /** The `ProviderInputSpecV1.kind` these inputs materialize as. */
  kind: string;
  /** The provenance label shown for these inputs. */
  provenanceLabel: string;
  /** Media type of the materialized bytes. */
  mediaType: string;
  /** Sealed caps — part of the plan digest, never a runtime opinion. */
  maxItems: number;
  maxBytes: number;
  /** The invocation-input key under which the inputId→path table is placed. */
  pathTableKey: string;
}

export interface ProviderPhaseBodyV2 {
  providerRoleId: string;
  /** Optional: absent means this phase reaches no retained source — today's behaviour. */
  sourceEvidenceDescriptor?: SourceEvidenceDescriptorV2;
  /** Optional: this phase reads one member-bearing artifact's verified members. */
  artifactEvidenceDescriptor?: ArtifactEvidenceDescriptorV2;
  /** Optional: this phase reads host-derived page evidence (P5c §2a). */
  pageEvidenceDescriptor?: PageEvidenceDescriptorV2;
  /**
   * The pack-shipped CLOSED template the provider request is rendered from.
   *
   * IT REUSES THE RENDER-TEMPLATE GRAMMAR ON PURPOSE. That grammar is already a
   * closed node union with no expression, path, include or helper arm, so a
   * request cannot carry executable interpolation — and it is already folded
   * into the recipe digest, which means the QUESTION a provider is asked is
   * sealed by the same digest that seals the pin and the envelope. An approved
   * plan can therefore only ask what it was approved to ask; inventing a second
   * template language would have put the request outside that seal.
   */
  requestTemplateRef: string;
}

/** context-assemble phase body (section 16.2). */
export interface ContextPhaseBodyV2 {
  eligibilityPolicyId: string;
  contentTiers: string[];
  evidenceClasses: string[];
  itemBudget: number;
  byteBudget: number;
  tokenBudget: number;
  orderingPolicyId: string;
}

/** The closed set operations set-select supports (section 16.3). */
type SelectOperationV2 =
  | "dedupe" | "filter" | "sort" | "top-n"
  | "union" | "intersection" | "difference" | "group-by";

/** set-select phase body (section 16.3). No inline comparator or expression. */
/**
 * Where a selected item's IDENTITY comes from (section 16.3).
 *
 * `position` is the host's default: one item per source record under
 * `source-<i>`, the index in the caller's list. That is stable within a run —
 * the executing phase and the materializer derive it from the same sealed bytes
 * — and it is the right answer when records ARE the caller's list, as an
 * explicit-source import is.
 *
 * `identity-fields` derives the identity from the item's own
 * {@link SelectPhaseBodyV2.identityFields} values instead, which is what a pack
 * needs whenever the same real-world thing must get the same identity across
 * runs that pass DIFFERENT lists. Seeding a catalog is the motivating case:
 * under positional identity, seeding one already-present concept compares it
 * against whatever happens to sit at that index, so the run reports a collision
 * with an unrelated page and never notices the concept is already there.
 */
export type SelectIdentitySourceV2 = "position" | "identity-fields";

/**
 * The parameterised closed-set admission predicate (section 16.3): the row's
 * declared field must equal EXACTLY ONE of the declared values by full-string
 * equality. The value-set rules live in the parser — non-empty list, each value
 * a non-empty bounded string, all distinct — so a malformed set refuses at
 * parse time, before any run exists.
 */
export interface SelectOneOfPredicateV2 {
  id: "one-of";
  field: string;
  values: string[];
}

/** One filter predicate entry: a registered parameterless id, or parameterised one-of. */
export type SelectFilterPredicateV2 = string | SelectOneOfPredicateV2;

export interface SelectPhaseBodyV2 {
  operation: SelectOperationV2;
  identityFields: string[];
  sortFields: string[];
  filterPredicateIds: SelectFilterPredicateV2[];
  overflowDisposition: ExpansionDeficitDispositionV2;
  completenessClass: string;
  groupByField?: string;
  topN?: number;
  /** Absent is `position` — every pack authored before this field is unchanged. */
  identityFrom?: SelectIdentitySourceV2;
}

/** One registered-rule binding with closed scalar parameters (section 16.4). */
export interface RuleBindingV2 {
  ruleId: string;
  ruleVersion: string;
  parameters: RuleParameterV2[];
}

/** One closed scalar parameter supplied to a registered rule (section 16.4). */
export interface RuleParameterV2 {
  paramId: string;
  value: string | number | boolean;
}

/** rule-evaluate phase body (section 16.4). */
export interface ValidatePhaseBodyV2 {
  ruleBindings: RuleBindingV2[];
}

/**
 * render-template phase body (section 16.5). templateRef is a registered id.
 * `escapingPolicyId` is VALIDATED-AND-PINNED at parse against the handler's
 * registered policy set (today exactly `per-node`); what EXECUTES is each field
 * node's own registered `escaping`, applied on insertion — the pinned body id
 * and the per-node semantics can therefore never silently disagree.
 */
export interface RenderPhaseBodyV2 {
  templateRef: string;
  formatId: string;
  escapingPolicyId: string;
  inputEvidenceRefs: string[];
}

/** The nine closed reconcile finding classes (section 16.6). */
type ReconcileFindingClassV2 =
  | "absent" | "identical" | "compatible-update" | "conflicting"
  | "duplicate-identity" | "supersession-candidate" | "stale-precondition"
  | "unavailable-authority" | "unsupported-mutation";

/** reconcile phase body (section 16.6). Never writes. */
export interface ReconcilePhaseBodyV2 {
  reconcilePolicyId: string;
  comparedEvidenceClass: string;
  findingClasses: ReconcileFindingClassV2[];
  /**
   * The canonical projection to apply to proposals BEFORE comparing them.
   *
   * WITHOUT IT, RECONCILE COMPARES THE WRONG VOCABULARY. Proposals carry the
   * caller's INPUT field names while the store snapshot carries PAGE
   * FRONTMATTER, so unless a pack happens to name its inputs exactly as its
   * page fields the two payload digests can never match — `identical` becomes
   * unreachable and every re-run reports `conflicting`. The behaviour looks
   * right (both classes fail an `absent` gate) while the reported reason is
   * wrong, and any rule that treats the classes differently breaks silently.
   *
   * Naming the SAME projection the terminal uses is what keeps the comparison
   * and the write from drifting: one declaration, applied once.
   */
  projectionRef?: string;
  /**
   * The proposed-evidence field carrying a CALLER-SEALED author-read digest, gated
   * IN-RECONCILE against the same snapshot's host-derived current-digest before it
   * is stripped (see handlers/reconcile.ts). It names a field, never a value: the
   * caller reads the page, seals its whole-buffer digest (`sha256:<64hex>`) under
   * this field, and reconcile REFUSES a proposal whose sealed digest no longer
   * equals the store's current page — so a page that changed between the caller's
   * read and this comparison cannot be silently overwritten. A proposal that does
   * not carry the field (a direct caller that sealed none) is not gated; a present
   * value is parsed FAIL-CLOSED (canonical form required) and must match exactly.
   *
   * GENERIC: the field name is the pack's to choose and carries no product
   * vocabulary. Because the snapshot's current-digest becomes the update's
   * precondition downstream, a passing guard makes the mutation precondition equal
   * the author-read digest — the reusable primitive an artifact-UPDATE stage needs.
   */
  expectedCurrentDigestRef?: string;
}

/**
 * One CANONICAL PROJECTION: how a pack turns caller input into the fields a
 * page of some profile class actually carries.
 *
 * It exists so the comparison and the write share one definition. Reconcile
 * applies it to proposals before comparing them with the store; the terminal
 * drafts from the result. Declaring the mapping twice — once for each — is the
 * defect this shape removes, because two copies drift and the drift is silent.
 */
export interface PackProjectionV2 {
  projectionId: string;
  targetProfileClass: string;
  fieldMappings: IntentFieldMappingV2[];
  /** Target fields the page-payload formatter emits as one-element lists. */
  listFields?: string[];
}

/** The closed Milestone A mutation kinds an intent phase may propose (section 16.7). */
type IntentMutationKindV2 =
  | "artifact-upsert" | "artifact-update" | "artifact-delete" | "catalog-append" | "projection-register"
  | "relation-upsert" | "lifecycle-transition";

/** The closed host-derived identities an intent mapping may reference (section 16.7). */
type IntentIdentityKindV2 = "run-id" | "principal" | "host-timestamp";

/**
 * One closed intent field mapping (section 16.7). It may only select a named phase
 * input, a bounded constant validated against the target schema, or a host-derived
 * identity — never a concatenated path, provider call, or arbitrary mutation JSON.
 */
export type IntentFieldMappingV2 =
  | { targetField: string; source: "phase-input"; ref: string }
  | { targetField: string; source: "constant"; value: string | number | boolean }
  | { targetField: string; source: "host-identity"; identityKind: IntentIdentityKindV2 };

/**
 * One intent GROUP (section 16.7): a mutation kind, its target class, and the
 * field mappings that draft it. By default a group drafts once per evidence
 * item; `whenPresent` names an item field, gating the group to the items that
 * carry it non-empty — how one terminal drafts a projection page from the
 * render output item alone while sibling groups draft per source item.
 *
 * `whenEquals` gates by VALUE instead of presence, which is what dispositioning
 * a reconciliation verdict requires: "draft this only where the comparison said
 * `absent`". Presence alone cannot express it — every compared item carries a
 * `findingClass`, and the group must act on WHICH one.
 *
 * DECLARING BOTH IS A CONJUNCTION: the item must carry the `whenPresent` field
 * AND match the `whenEquals` value. A single terminal intent phase receives the
 * union of every compare output, so a class-confined group needs "MY key field
 * present AND finding-class == absent" — one gate alone matches every class's
 * rows or every finding state's rows.
 */
export interface IntentGroupValueGateV2 {
  field: string;
  value: string;
}

export interface IntentGroupV2 {
  mutationKind: IntentMutationKindV2;
  targetProfileClass: string;
  fieldMappings: IntentFieldMappingV2[];
  /**
   * Draft from evidence that a projection has ALREADY canonicalized.
   *
   * A group naming this takes each of the projection's target fields straight
   * off the item of the same name instead of re-running the mapping — applying
   * a projection twice would look for source fields the first application
   * already consumed. This is what makes "one mapping, two consumers" true at
   * runtime and not merely in the declaration.
   */
  projectionRef?: string;
  whenPresent?: string;
  whenEquals?: IntentGroupValueGateV2;
  /**
   * Target fields the page-payload formatter emits as ONE-element lists — the
   * scalar evidence grammar cannot carry a list, but a profile may require one.
   */
  listFields?: string[];
}

/**
 * intent-compile phase body (section 16.7). intentTemplateRef is a registered
 * id. `intents` carries one group per mutation kind/class the terminal drafts —
 * the parser also accepts the original single-triple form as sugar for a
 * one-group list, so existing single-kind recipes parse unchanged.
 */
export interface IntentPhaseBodyV2 {
  intentTemplateRef: string;
  intents: IntentGroupV2[];
}

/** The registered Orchestration V2 join variants a pack may select (section 16.8). */
type JoinVariantV2 =
  | "ordered-evidence-set" | "required-optional-summary"
  | "keyed-result-map" | "multi-format-collection";

/** join phase body (section 16.8). Lowered to an orchestration join phase. */
export interface JoinPhaseBodyV2 {
  variant: JoinVariantV2;
  keyField?: string;
  formatIds?: string[];
}

/** gate phase body (section 15.4): one registered Orchestration V2 gate kind. */
export interface GatePhaseBodyV2 {
  gateKindId: string;
}

/** The kind-specific closed source body for each phase kind (sections 16.2-16.9). */
interface PhaseBodyByKindV2 {
  provider: ProviderPhaseBodyV2;
  context: ContextPhaseBodyV2;
  select: SelectPhaseBodyV2;
  validate: ValidatePhaseBodyV2;
  render: RenderPhaseBodyV2;
  reconcile: ReconcilePhaseBodyV2;
  intent: IntentPhaseBodyV2;
  join: JoinPhaseBodyV2;
  gate: GatePhaseBodyV2;
}

/** The union of every closed phase body (used by the flat body-dispatch table). */
export type PackPhaseBodyV2 = PhaseBodyByKindV2[PackPhaseKindV2];

/**
 * One recipe phase (section 15.2): the common declaration plus one kind-specific
 * closed body, discriminated by `kind`. The body carries no redundant kind field;
 * the phase kind is the single discriminant that selects the host-handler family.
 */
export type PackPhaseV2 = {
  [K in PackPhaseKindV2]: PhaseCommonV2 & { kind: K; body: PhaseBodyByKindV2[K] };
}[PackPhaseKindV2];

/**
 * One recipe as authoring data (section 15.1, FULL shape). It carries no runtime
 * authority; the plan compiler resolves every reference and derives all runtime
 * digests, pins, bounds, and gates (sections 15.1, 17). Its sub-contracts and
 * phase bodies are fully PARSED here as closed shapes, never deferred.
 */
export interface PackRecipeV2 {
  recipeId: string;
  recipeVersion: string;
  atomicityClass: RecipeAtomicityClassV2;
  inputContract: RecipeInputContractV2;
  phases: PackPhaseV2[];
  completenessClasses: CompletenessClassSourceV2[];
  outputContract: RecipeOutputContractSourceV2;
  bounds: RecipeBoundsSourceV2;
}
