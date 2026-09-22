/**
 * @file src/operations-packs/parse-phase-bodies.ts
 * @description The nine closed kind-specific phase-body parsers (design sections
 * 16.2-16.9 and 15.4), dispatched through one flat table keyed by phase kind so
 * cyclomatic complexity stays low and each builder does one thing. Every builder
 * accepts ONLY registered ids (validated as slug / dotted ref-id), closed enum
 * discriminants, bounded scalars, and typed references. There is deliberately no
 * builder field that reads free-form text, a filesystem path, a template body, an
 * inline comparator, or arbitrary JSON — so a shell string, an absolute or
 * writable path, or an `eval(...)` expression (section 10.3) cannot be represented
 * in any phase body. The mutation-witness fields are `render.templateRef` and
 * `intent.intentTemplateRef`: both are dotted ref-ids, so a forbidden value is
 * refused, and loosening either to a free-form string reddens the negative sweep.
 */

import { isValidMediaType } from "../capability-providers/authority/exposure.js";
import { RESERVED_PROVIDER_INPUT_KEYS } from "../preparations/plan-types.js";
import { REGISTERED_ESCAPING_POLICY_IDS } from "./handlers/render-template.js";
import { PackParseError } from "./problems.js";
import { parsePageEvidenceDescriptor } from "./parse-page-evidence.js";
import { array, enumValue, exact, record, textValue, type JsonRecord } from "../operation-bundles/manifest-values.js";
import {
  FORBIDDEN_PACK_TEXT_CONTROL, MAX_CLOSED_STRING_SET, MAX_DEFAULT_STRING_BYTES,
  MAX_INTENT_FIELD_MAPPINGS, MAX_PHASE_FIELDS,
  MAX_INTENT_GROUPS, MAX_PHASE_RULE_BINDINGS, MAX_RECONCILE_FINDING_CLASSES, MAX_RULE_PARAMETERS,
} from "./constants.js";
import { assertRefId, assertSlug, assertPageFieldName, assertUnreservedSlug, assertPackVersion } from "./ids.js";
import { PAGE_BODY_FIELD } from "./handlers/page-payload.js";
import type { ArtifactEvidenceDescriptorV2,
  ContextPhaseBodyV2, GatePhaseBodyV2, IntentFieldMappingV2, IntentGroupV2, PackProjectionV2,
  IntentGroupValueGateV2, IntentPhaseBodyV2,
  JoinPhaseBodyV2, PackPhaseBodyV2, PackPhaseKindV2, ProviderPhaseBodyV2,
  ReconcilePhaseBodyV2, RenderPhaseBodyV2, RuleBindingV2, RuleParameterV2,
  SelectFilterPredicateV2, SelectPhaseBodyV2, SourceEvidenceDescriptorV2, ValidatePhaseBodyV2,
} from "./recipe-types.js";
import {
  assertUniqueStrings, boundedScalar, closedValueSet, intentConstantScalar, positiveCount, slugList,
} from "./values.js";

const SELECT_OPERATIONS = [
  "dedupe", "filter", "sort", "top-n", "union", "intersection", "difference", "group-by",
] as const;
const FINDING_CLASSES = [
  "absent", "identical", "compatible-update", "conflicting", "duplicate-identity",
  "supersession-candidate", "stale-precondition", "unavailable-authority", "unsupported-mutation",
] as const;
const MUTATION_KINDS = [
  "artifact-upsert", "artifact-update", "artifact-delete", "catalog-append", "projection-register",
  "relation-upsert",
  "lifecycle-transition",
] as const;
const IDENTITY_KINDS = ["run-id", "principal", "host-timestamp"] as const;
const MAPPING_SOURCES = ["phase-input", "constant", "host-identity"] as const;
const JOIN_VARIANTS = [
  "ordered-evidence-set", "required-optional-summary", "keyed-result-map", "multi-format-collection",
] as const;

/**
 * provider body (section 15.2): a declared role AND the closed template its
 * request is rendered from.
 *
 * Both are required. A phase naming a role but no request would compile to
 * "ask this provider something unspecified", which the plan digest could not
 * seal and no reviewer could approve.
 */
function parseProviderBody(value: unknown, label: string): ProviderPhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["providerRoleId", "requestTemplateRef"], ["sourceEvidenceDescriptor", "artifactEvidenceDescriptor", "pageEvidenceDescriptor"]);
  return {
    providerRoleId: assertSlug(node.providerRoleId),
    requestTemplateRef: assertRefId(node.requestTemplateRef),
    ...(node.sourceEvidenceDescriptor === undefined ? {} : {
      sourceEvidenceDescriptor:
        parseSourceEvidenceDescriptor(node.sourceEvidenceDescriptor, `${label}.sourceEvidenceDescriptor`),
    }),
    ...(node.artifactEvidenceDescriptor === undefined ? {} : {
      artifactEvidenceDescriptor:
        parseArtifactEvidenceDescriptor(node.artifactEvidenceDescriptor, `${label}.artifactEvidenceDescriptor`),
    }),
    ...(node.pageEvidenceDescriptor === undefined ? {} : {
      pageEvidenceDescriptor:
        parsePageEvidenceDescriptor(node.pageEvidenceDescriptor, `${label}.pageEvidenceDescriptor`),
    }),
  };
}

/** The seven fields both evidence descriptors share, parsed identically. */
function parseDescriptorTail(node: JsonRecord, label: string): {
  inputIdPrefix: string; kind: string; provenanceLabel: string; mediaType: string;
  maxItems: number; maxBytes: number; pathTableKey: string;
} {
  return {
    inputIdPrefix: assertSlug(node.inputIdPrefix), kind: assertSlug(node.kind),
    provenanceLabel: assertSlug(node.provenanceLabel), mediaType: mediaTypeOf(node.mediaType, label),
    maxItems: positiveCount(node.maxItems, `${label}.maxItems`),
    maxBytes: positiveCount(node.maxBytes, `${label}.maxBytes`),
    pathTableKey: pathTableKeyOf(node.pathTableKey, label),
  };
}

/**
 * The sealed artifact-evidence descriptor (AS-4 P4.2, D41a): every field named
 * explicitly, columns distinct, counts positive and bounded. OPTIONAL on the
 * body — a plan written before this field existed parses unchanged and reads
 * no artifact, which is exactly the behaviour it was approved under.
 */
function parseArtifactEvidenceDescriptor(value: unknown, label: string): ArtifactEvidenceDescriptorV2 {
  const node = record(value, label);
  exact(node, [
    "refField", "memberNamesField", "memberDigestsField", "memberByteCountsField", "inputIdPrefix",
    "kind", "provenanceLabel", "mediaType", "maxItems", "maxBytes", "pathTableKey",
  ]);
  const fields = {
    refField: assertSlug(node.refField), memberNamesField: assertSlug(node.memberNamesField),
    memberDigestsField: assertSlug(node.memberDigestsField), memberByteCountsField: assertSlug(node.memberByteCountsField),
  };
  // Four DISTINCT fields: two sharing one would zip a digest against the
  // wrong member (or the ref) while every length check still passed.
  if (new Set(Object.values(fields)).size !== 4) {
    throw new PackParseError(`${label} names the same initial-input field twice`);
  }
  return { ...fields, ...parseDescriptorTail(node, label) };
}

/**
 * The sealed source-evidence descriptor (spec §2.1 generic change 1): every
 * field named explicitly, every count positive and bounded. OPTIONAL on the
 * body — a plan written before this field existed parses unchanged and reaches
 * no retained source, which is exactly the behaviour it was approved under.
 */
function parseSourceEvidenceDescriptor(value: unknown, label: string): SourceEvidenceDescriptorV2 {
  const node = record(value, label);
  exact(node, [
    "pathsField", "digestsField", "byteCountsField", "inputIdPrefix",
    "kind", "provenanceLabel", "mediaType", "maxItems", "maxBytes", "pathTableKey",
  ]);
  const fields = {
    pathsField: assertSlug(node.pathsField), digestsField: assertSlug(node.digestsField),
    byteCountsField: assertSlug(node.byteCountsField),
  };
  // Three DISTINCT columns: two sharing a field would zip a digest against the
  // wrong file while every length check still passed.
  if (new Set(Object.values(fields)).size !== 3) {
    throw new PackParseError(`${label} names the same initial-input field for two columns`);
  }
  return { ...fields, ...parseDescriptorTail(node, label) };
}

/**
 * The provider input record's own keys; a descriptor claiming one would have
 * its path table land where the platform writes the SEALED request or its
 * template ref. Assembly also writes the platform fields last, but authoring
 * a reserved key is an error to surface, not to silently shadow.
 */

/** A syntactic `type/subtype` media type — the same grammar invocation enforces. */
function mediaTypeOf(value: unknown, label: string): string {
  const parsed = textValue(value, `${label}.mediaType`, 128);
  if (!isValidMediaType(parsed)) {
    throw new PackParseError(`${label}.mediaType is not a media type: ${parsed}`);
  }
  return parsed;
}

/** A path-table key: a slug that is not a reserved provider input key. */
function pathTableKeyOf(value: unknown, label: string): string {
  const key = assertSlug(value);
  if (RESERVED_PROVIDER_INPUT_KEYS.has(key)) {
    throw new PackParseError(`${label}.pathTableKey may not take the reserved input key: ${key}`);
  }
  return key;
}

/** context-assemble body (section 16.2): registered policies plus finite budgets. */
function parseContextBody(value: unknown, label: string): ContextPhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["eligibilityPolicyId", "contentTiers", "evidenceClasses", "itemBudget", "byteBudget", "tokenBudget", "orderingPolicyId"]);
  return {
    eligibilityPolicyId: assertRefId(node.eligibilityPolicyId),
    contentTiers: slugList(node.contentTiers, `${label}.contentTiers`, MAX_CLOSED_STRING_SET),
    evidenceClasses: slugList(node.evidenceClasses, `${label}.evidenceClasses`, MAX_CLOSED_STRING_SET),
    itemBudget: positiveCount(node.itemBudget, `${label}.itemBudget`),
    byteBudget: positiveCount(node.byteBudget, `${label}.byteBudget`),
    tokenBudget: positiveCount(node.tokenBudget, `${label}.tokenBudget`),
    orderingPolicyId: assertSlug(node.orderingPolicyId),
  };
}

/** The closed set of identity sources a select body may name (section 16.3). */
const SELECT_IDENTITY_SOURCES = ["position", "identity-fields"] as const;

/** The only registered parameterised filter-predicate id (section 16.3). */
const PARAMETERISED_PREDICATE_IDS = ["one-of"] as const;

/**
 * One filter predicate entry: a plain registered id, or the parameterised
 * `one-of` form carrying its closed value set. The admission rules live HERE,
 * in the grammar: `values` must be a non-empty list of distinct, non-empty
 * bounded strings ({@link closedValueSet}), so a malformed value set refuses at
 * parse time rather than surfacing as runtime behaviour.
 *
 * A parameterised id written BARE is refused for the same reason. `one-of` is a
 * well-formed ref-id, so the string branch would accept it and the handler would
 * throw "not registered" mid-run — in a judge recipe, after the provider phase
 * has already spent a real model call. The parser knows which ids are
 * parameterised, so it owns that refusal.
 */
function parseFilterPredicate(value: unknown, label: string): SelectFilterPredicateV2 {
  if (typeof value === "string") return assertPlainPredicateId(value, label);
  const node = record(value, label);
  exact(node, ["id", "field", "values"]);
  return {
    id: enumValue(node.id, PARAMETERISED_PREDICATE_IDS, `${label}.id`),
    field: assertSlug(node.field),
    values: closedValueSet(node.values, `${label}.values`, MAX_CLOSED_STRING_SET),
  };
}

/** One parameterless predicate id: a ref-id that does not name a parameterised form. */
function assertPlainPredicateId(value: string, label: string): string {
  const id = assertRefId(value);
  if ((PARAMETERISED_PREDICATE_IDS as readonly string[]).includes(id)) {
    throw new PackParseError(`${label} must declare ${id} in its parameterised form, not as a bare id`);
  }
  return id;
}

/** The bounded predicate list; plain ids stay distinct exactly as before. */
function parseFilterPredicates(value: unknown, label: string): SelectFilterPredicateV2[] {
  const entries = array(value, label, MAX_PHASE_FIELDS)
    .map((item, index) => parseFilterPredicate(item, `${label}[${index}]`));
  assertUniqueStrings(entries.filter((entry): entry is string => typeof entry === "string"), label);
  return entries;
}

/** Attach the optional group-by field, top-n cap and identity source (section 16.3). */
function withSelectOptionals(base: SelectPhaseBodyV2, node: JsonRecord, label: string): SelectPhaseBodyV2 {
  const groupBy = node.groupByField === undefined ? base : { ...base, groupByField: assertSlug(node.groupByField) };
  const topN = node.topN === undefined ? groupBy : { ...groupBy, topN: positiveCount(node.topN, `${label}.topN`) };
  if (node.identityFrom === undefined) return topN;
  return { ...topN, identityFrom: enumValue(node.identityFrom, SELECT_IDENTITY_SOURCES, `${label}.identityFrom`) };
}

/** set-select body (section 16.3): a closed operation over declared fields/predicates. */
function parseSelectBody(value: unknown, label: string): SelectPhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["operation", "identityFields", "sortFields", "filterPredicateIds", "overflowDisposition", "completenessClass"], ["groupByField", "topN", "identityFrom"]);
  const base: SelectPhaseBodyV2 = {
    operation: enumValue(node.operation, SELECT_OPERATIONS, `${label}.operation`),
    identityFields: slugList(node.identityFields, `${label}.identityFields`, MAX_PHASE_FIELDS),
    sortFields: slugList(node.sortFields, `${label}.sortFields`, MAX_PHASE_FIELDS),
    filterPredicateIds: parseFilterPredicates(node.filterPredicateIds, `${label}.filterPredicateIds`),
    overflowDisposition: enumValue(node.overflowDisposition, ["fail", "record-deficit"], `${label}.overflowDisposition`),
    completenessClass: assertSlug(node.completenessClass),
  };
  return withSelectOptionals(base, node, label);
}

/** One closed scalar parameter supplied to a registered rule (section 16.4). */
function parseRuleParameter(value: unknown, label: string): RuleParameterV2 {
  const node = record(value, label);
  exact(node, ["paramId", "value"]);
  return { paramId: assertSlug(node.paramId), value: boundedScalar(node.value, `${label}.value`) };
}

/** One registered rule binding with closed scalar parameters (section 16.4). */
function parseRuleBinding(value: unknown, label: string): RuleBindingV2 {
  const node = record(value, label);
  exact(node, ["ruleId", "ruleVersion", "parameters"]);
  const parameters = array(node.parameters, `${label}.parameters`, MAX_RULE_PARAMETERS)
    .map((item, index) => parseRuleParameter(item, `${label}.parameters[${index}]`));
  assertUniqueStrings(parameters.map((parameter) => parameter.paramId), `${label}.parameters`);
  return { ruleId: assertRefId(node.ruleId), ruleVersion: assertPackVersion(node.ruleVersion), parameters };
}

/** rule-evaluate body (section 16.4): registered rule bindings only. */
function parseValidateBody(value: unknown, label: string): ValidatePhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["ruleBindings"]);
  const ruleBindings = array(node.ruleBindings, `${label}.ruleBindings`, MAX_PHASE_RULE_BINDINGS)
    .map((item, index) => parseRuleBinding(item, `${label}.ruleBindings[${index}]`));
  assertUniqueStrings(ruleBindings.map((binding) => binding.ruleId), `${label}.ruleBindings`);
  return { ruleBindings };
}

/** Fail closed unless the body-level escaping policy id is registered. */
function registeredEscapingPolicy(policyId: string, label: string): string {
  if (!REGISTERED_ESCAPING_POLICY_IDS.has(policyId)) {
    throw new PackParseError(`${label}.escapingPolicyId ${policyId} is not a registered escaping policy`);
  }
  return policyId;
}

/** render-template body (section 16.5): a registered template + format + escaping. */
function parseRenderBody(value: unknown, label: string): RenderPhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["templateRef", "formatId", "escapingPolicyId", "inputEvidenceRefs"]);
  return {
    templateRef: assertRefId(node.templateRef),
    formatId: assertSlug(node.formatId),
    escapingPolicyId: registeredEscapingPolicy(assertSlug(node.escapingPolicyId), label),
    inputEvidenceRefs: slugList(node.inputEvidenceRefs, `${label}.inputEvidenceRefs`, MAX_PHASE_FIELDS),
  };
}

/** reconcile body (section 16.6): a registered policy over one evidence class. */
function parseReconcileBody(value: unknown, label: string): ReconcilePhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["reconcilePolicyId", "comparedEvidenceClass", "findingClasses"], ["projectionRef", "expectedCurrentDigestRef"]);
  const findingClasses = array(node.findingClasses, `${label}.findingClasses`, MAX_RECONCILE_FINDING_CLASSES)
    .map((item, index) => enumValue(item, FINDING_CLASSES, `${label}.findingClasses[${index}]`));
  assertUniqueStrings(findingClasses, `${label}.findingClasses`);
  return {
    reconcilePolicyId: assertRefId(node.reconcilePolicyId),
    comparedEvidenceClass: assertSlug(node.comparedEvidenceClass),
    findingClasses,
    ...(node.projectionRef === undefined ? {} : { projectionRef: assertRefId(node.projectionRef) }),
    // The author-read-digest gate names a PROPOSED field. It is a slug the caller
    // seals its value under; a reserved on-disk name (`current-digest`) is refused
    // so it can never alias the very snapshot field it is compared against.
    ...(node.expectedCurrentDigestRef === undefined ? {} : { expectedCurrentDigestRef: assertUnreservedSlug(node.expectedCurrentDigestRef) }),
  };
}

/**
 * The mutation kinds whose draft fields become PAGE frontmatter keys, and so
 * may target a camelCase profile field. Every other kind (relation, catalog,
 * projection-register) keeps the slug-only target vocabulary its draft shape
 * depends on.
 */
const PAGE_MUTATION_KINDS: ReadonlySet<string> = new Set([
  "artifact-upsert", "artifact-update", "artifact-delete",
]);

/** One closed intent field mapping (section 16.7): input, constant, or identity. */
function parseFieldMapping(value: unknown, label: string, pageTargeted: boolean): IntentFieldMappingV2 {
  const node = record(value, label);
  const source = enumValue(node.source, MAPPING_SOURCES, `${label}.source`);
  // Only the TARGET widens: it becomes a page frontmatter key, which a profile
  // may declare in camelCase. The `ref` names an evidence/action-input field,
  // whose vocabulary stays slug-only (action inputSchema keys are slugs), so
  // the mapping is exactly where the two vocabularies meet.
  const targetField = pageTargeted ? assertPageFieldName(node.targetField) : assertSlug(node.targetField);
  if (source === "phase-input") {
    exact(node, ["targetField", "source", "ref"]);
    // A ref reads an evidence field, and reconcile OVERWRITES the reserved
    // names on the item it passes on — so a mapping sourcing one would read the
    // pipeline's value in place of the caller's. Refused on both sides.
    return { targetField, source, ref: assertUnreservedSlug(node.ref) };
  }
  if (source === "constant") {
    exact(node, ["targetField", "source", "value"]);
    return { targetField, source, value: intentConstantScalar(node.value, `${label}.value`) };
  }
  exact(node, ["targetField", "source", "identityKind"]);
  return { targetField, source, identityKind: enumValue(node.identityKind, IDENTITY_KINDS, `${label}.identityKind`) };
}

/**
 * One pack-level canonical projection: the mapping BOTH the comparison and the
 * write use, parsed closed.
 *
 * `listFields` is checked against the mapped target fields for the same reason
 * an intent group checks it — a list hint naming a field nothing maps would
 * shape a payload member that does not exist.
 */
export function parseProjection(value: unknown, label: string): PackProjectionV2 {
  const node = record(value, label);
  exact(node, ["projectionId", "targetProfileClass", "fieldMappings"], ["listFields"]);
  // A projection maps evidence onto a PROFILE CLASS, so its targets ARE page
  // frontmatter keys and take the page-field vocabulary: the store snapshot
  // reads a page's own keys, and a projection that could not name a camelCase
  // declared field could never compare it.
  const fieldMappings = array(node.fieldMappings, `${label}.fieldMappings`, MAX_INTENT_FIELD_MAPPINGS)
    .map((item, index) => parseFieldMapping(item, `${label}.fieldMappings[${index}]`, true));
  assertUniqueStrings(fieldMappings.map((mapping) => mapping.targetField), `${label}.fieldMappings`);
  for (const mapping of fieldMappings) {
    // See handlers/projection.ts: a projection feeds a COMPARISON, and a value
    // that differs every run can never equal what the store holds.
    if (mapping.source === "host-identity") {
      throw new PackParseError(`${label}.fieldMappings may not map a host identity into a comparison`);
    }
  }
  const mapped = new Set(fieldMappings.map((mapping) => mapping.targetField));
  const listFields = node.listFields === undefined
    ? undefined
    : slugList(node.listFields, `${label}.listFields`, MAX_INTENT_FIELD_MAPPINGS);
  for (const field of listFields ?? []) {
    if (!mapped.has(field)) throw new PackParseError(`${label}.listFields names an unmapped field ${field}`);
  }
  return {
    projectionId: assertRefId(node.projectionId),
    targetProfileClass: assertSlug(node.targetProfileClass),
    fieldMappings,
    ...(listFields === undefined ? {} : { listFields }),
  };
}

/** The closed per-group members of one intent group (section 16.7). */
function parseIntentGroupMembers(node: JsonRecord, label: string): IntentGroupV2 {
  // The KIND decides the target vocabulary, so it is read BEFORE the mappings:
  // only a page draft's targets become frontmatter keys.
  const mutationKind = enumValue(node.mutationKind, MUTATION_KINDS, `${label}.mutationKind`);
  const fieldMappings = array(node.fieldMappings, `${label}.fieldMappings`, MAX_INTENT_FIELD_MAPPINGS)
    .map((item, index) => parseFieldMapping(item, `${label}.fieldMappings[${index}]`, PAGE_MUTATION_KINDS.has(mutationKind)));
  assertUniqueStrings(fieldMappings.map((mapping) => mapping.targetField), `${label}.fieldMappings`);
  const listFields = parseListFields(node, mutationKind, fieldMappings, label);
  return {
    mutationKind,
    targetProfileClass: assertSlug(node.targetProfileClass),
    fieldMappings,
    ...(node.whenPresent === undefined ? {} : { whenPresent: assertSlug(node.whenPresent) }),
    ...(node.whenEquals === undefined ? {} : { whenEquals: parseValueGate(node, label) }),
    ...(listFields === undefined ? {} : { listFields }),
    ...(node.projectionRef === undefined ? {} : { projectionRef: assertRefId(node.projectionRef) }),
  };
}

/**
 * Parse the group's optional `listFields`, CLOSED to where the hint has
 * semantics: only a PAGE draft's frontmatter is list-formatted, so only an
 * `artifact-upsert` group may declare it; only a MAPPED field can be emitted;
 * and the reserved `content` body field is never frontmatter at all. Anywhere
 * else the formatter would silently ignore the hint — a parse-time refusal
 * naming the rule beats a pack that ships a scalar where it promised a list.
 */
function parseListFields(
  node: JsonRecord, mutationKind: string,
  fieldMappings: readonly { targetField: string }[], label: string,
): string[] | undefined {
  if (node.listFields === undefined) return undefined;
  if (mutationKind !== "artifact-upsert" && mutationKind !== "artifact-update") {
    throw new PackParseError(`${label}.listFields is only meaningful on artifact-upsert groups`);
  }
  const listFields = slugList(node.listFields, `${label}.listFields`, MAX_INTENT_FIELD_MAPPINGS);
  const targets = new Set(fieldMappings.map((mapping) => mapping.targetField));
  for (const field of listFields) {
    if (field === PAGE_BODY_FIELD) {
      throw new PackParseError(`${label}.listFields cannot name the reserved page body field: ${PAGE_BODY_FIELD}`);
    }
    if (!targets.has(field)) throw new PackParseError(`${label}.listFields names an unmapped field: ${field}`);
  }
  return listFields;
}

/**
 * One closed value gate: the item field to read and the exact value to match.
 *
 * The value is bounded pack-authored TEXT under the shared rule every other
 * pack string crosses — a gate that could carry control characters or unbounded
 * text would be a second string surface with its own habits.
 */
function parseValueGate(node: Record<string, unknown>, label: string): IntentGroupValueGateV2 {
  const gate = record(node.whenEquals, `${label} whenEquals`);
  exact(gate, ["field", "value"], []);
  const value = gate.value;
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_DEFAULT_STRING_BYTES
    || FORBIDDEN_PACK_TEXT_CONTROL.test(value)) {
    throw new PackParseError(`${label} whenEquals value is not bounded control-free text`);
  }
  return { field: assertSlug(gate.field), value };
}

/**
 * One closed intent group. `whenPresent` and `whenEquals` each optionally gate
 * it, and DECLARING BOTH IS A CONJUNCTION — the item must carry the field AND
 * match the value.
 *
 * The two gates used to be mutually exclusive by refusal here, which made a
 * single terminal intent phase unable to confine its groups: the phase receives
 * the UNION of every compare output, so a group gated only on
 * `finding-class == absent` matched an absent CONCEPT and wrote it into the
 * paper, method, person, and relation groups too. Two existing closed gates
 * composed with AND is the smallest grammar that can express "this class's rows,
 * in this finding state" — no new gate kind and no expression language.
 */
function parseIntentGroup(value: unknown, label: string): IntentGroupV2 {
  const node = record(value, label);
  exact(node, ["mutationKind", "targetProfileClass", "fieldMappings"], ["whenPresent", "whenEquals", "listFields", "projectionRef"]);
  return parseIntentGroupMembers(node, label);
}

/**
 * intent-compile body (section 16.7): a registered template + intent GROUPS.
 * Two closed forms — the group-list form, and the original single-triple form
 * accepted as sugar for a one-group list so existing recipes parse unchanged.
 */
function parseIntentBody(value: unknown, label: string): IntentPhaseBodyV2 {
  const node = record(value, label);
  if (node.intents !== undefined) {
    exact(node, ["intentTemplateRef", "intents"]);
    const intents = array(node.intents, `${label}.intents`, MAX_INTENT_GROUPS)
      .map((item, index) => parseIntentGroup(item, `${label}.intents[${index}]`));
    if (intents.length === 0) throw new PackParseError(`${label}.intents must declare at least one group`);
    return { intentTemplateRef: assertRefId(node.intentTemplateRef), intents };
  }
  exact(node, ["intentTemplateRef", "mutationKind", "targetProfileClass", "fieldMappings"]);
  return {
    intentTemplateRef: assertRefId(node.intentTemplateRef),
    intents: [parseIntentGroupMembers(node, label)],
  };
}

/** Attach the optional keyed / multi-format join selectors when present (16.8). */
function withJoinOptionals(base: JoinPhaseBodyV2, node: JsonRecord, label: string): JoinPhaseBodyV2 {
  const keyed = node.keyField === undefined ? base : { ...base, keyField: assertSlug(node.keyField) };
  return node.formatIds === undefined ? keyed : { ...keyed, formatIds: slugList(node.formatIds, `${label}.formatIds`, MAX_CLOSED_STRING_SET) };
}

/** join body (section 16.8): a registered orchestration join variant. */
function parseJoinBody(value: unknown, label: string): JoinPhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["variant"], ["keyField", "formatIds"]);
  return withJoinOptionals({ variant: enumValue(node.variant, JOIN_VARIANTS, `${label}.variant`) }, node, label);
}

/** gate body (section 15.4): one registered Orchestration V2 gate kind. */
function parseGateBody(value: unknown, label: string): GatePhaseBodyV2 {
  const node = record(value, label);
  exact(node, ["gateKindId"]);
  return { gateKindId: assertRefId(node.gateKindId) };
}

/** The flat body-dispatch table: one closed builder per registered phase kind. */
const PHASE_BODY_BUILDERS: Readonly<Record<PackPhaseKindV2, (value: unknown, label: string) => PackPhaseBodyV2>> = {
  provider: parseProviderBody,
  context: parseContextBody,
  select: parseSelectBody,
  validate: parseValidateBody,
  render: parseRenderBody,
  reconcile: parseReconcileBody,
  intent: parseIntentBody,
  join: parseJoinBody,
  gate: parseGateBody,
};

/** Parse one phase's kind-specific closed source body (sections 16.2-16.9, 15.4). */
export function parsePhaseBody(kind: PackPhaseKindV2, value: unknown, label: string): PackPhaseBodyV2 {
  return PHASE_BODY_BUILDERS[kind](value, label);
}
