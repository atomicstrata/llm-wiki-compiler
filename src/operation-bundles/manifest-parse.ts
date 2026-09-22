/**
 * @file src/operation-bundles/manifest-parse.ts
 * @description Bounded duplicate-key-free parser for the closed Milestone A
 * manifest grammar. It reconstructs fresh allowlisted DTOs and binds their
 * identity to the repository's sole RFC 8785 canonical digest implementation.
 */

import { MAX_MANIFEST_BYTES, MAX_MUTATIONS_PER_BUNDLE } from "./constants.js";
import {
  assertBundleId, assertCatalogRecordId, assertOperationRunId, catalogRecordId,
  mutationId, type BundleId, type MutationId,
} from "./ids.js";
import { assertProjectionRelativeOutput, assertRecipeId, assertWorkspaceId } from "./paths.js";
import { isSafeFilenameComponent, isSlugSafe, parseEntityId } from "../profile/identity.js";
import type { EntityId } from "../profile/types.js";
import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { validateRelationEvidence } from "../relations/relation-contract.js";
import type { CitationRef } from "../relations/types.js";
import {
  array, booleanValue, boundedDataObject, count, digest, enumValue, exact,
  MAX_LIST_ITEMS, parseList, payloadRef, record, textValue, timestamp, unique,
  type JsonRecord,
} from "./manifest-values.js";
import type {
  ArtifactOperationMutation, CatalogOperationMutation, KnowledgeAuthorityRef, LifecycleOperationMutation, OperationBound,
  OperationBundleManifest, OperationCompleteness, OperationDigest, OperationInputRef, OperationMutation, OperationPlanningWarning,
  OperationReconciliation, OperationsAuthorityRef, PageOperationMutation, PreparationEvidenceRef, ProjectionOperationMutation,
  RelationOperationMutation, ReconciliationResolution, SourceRetainMutation,
} from "./types.js";

const TOP_KEYS = ["schemaVersion", "bundleId", "runId", "workspaceId", "createdAt", "createdBy", "knowledgeAuthority", "operationsAuthority", "grantDigest", "safetyFloorDigest", "inputs", "preparationEvidence", "bounds", "completeness", "reconciliations", "mutations", "planningWarnings"] as const;
const TOP_OPTIONAL = ["supersedesBundleId", "recoversBundleId"] as const;
const MAX_MESSAGE_BYTES = 4_096;

/** Parse and rebuild one version-one manifest from bounded JSON text. */
export function parseOperationManifest(text: string): OperationBundleManifest {
  const root = record(parseBoundedUniqueJson(text, MAX_MANIFEST_BYTES), "manifest");
  exact(root, TOP_KEYS, TOP_OPTIONAL);
  if (root.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
  const bundleId = assertBundleId(root.bundleId);
  const reconciliations = parseList(root.reconciliations, "reconciliations", parseReconciliation);
  const mutations = parseMutations(root.mutations, bundleId, reconciliations);
  return optionalEdges(root, {
    schemaVersion: 1, bundleId, runId: assertOperationRunId(root.runId), workspaceId: assertWorkspaceId(root.workspaceId),
    createdAt: timestamp(root.createdAt), createdBy: textValue(root.createdBy, "createdBy"), knowledgeAuthority: parseKnowledgeAuthority(root.knowledgeAuthority),
    operationsAuthority: parseOperationsAuthority(root.operationsAuthority), grantDigest: digest(root.grantDigest, "grantDigest"),
    safetyFloorDigest: digest(root.safetyFloorDigest, "safetyFloorDigest"), inputs: unique(parseList(root.inputs, "inputs", parseInput), "id", "inputs"),
    preparationEvidence: parseList(root.preparationEvidence, "preparationEvidence", parseEvidence), bounds: unique(parseList(root.bounds, "bounds", parseBound), "name", "bounds"),
    completeness: parseCompleteness(root.completeness), reconciliations: unique(reconciliations, "id", "reconciliations"), mutations,
    planningWarnings: parseList(root.planningWarnings, "planningWarnings", parseWarning),
  });
}

/** Return the manifest digest from the repository's shared canonicalizer. */
export function operationManifestDigest(manifest: OperationBundleManifest): string { return canonicalDigest(manifest); }

/** Add optional immutable graph edges only when the input declares them. */
function optionalEdges(root: JsonRecord, base: OperationBundleManifest): OperationBundleManifest {
  const supersedesBundleId = root.supersedesBundleId === undefined ? undefined : assertBundleId(root.supersedesBundleId);
  const recoversBundleId = root.recoversBundleId === undefined ? undefined : assertBundleId(root.recoversBundleId);
  return { ...base, ...(supersedesBundleId === undefined ? {} : { supersedesBundleId }), ...(recoversBundleId === undefined ? {} : { recoversBundleId }) };
}

/** Parse one knowledge-profile authority reference. */
function parseKnowledgeAuthority(value: unknown): KnowledgeAuthorityRef {
  const obj = record(value, "knowledgeAuthority");
  exact(obj, ["id", "digest"]);
  return { id: textValue(obj.id, "knowledgeAuthority.id"), digest: digest(obj.digest, "knowledgeAuthority.digest") };
}

/** Parse one operations-pack and action authority reference. */
function parseOperationsAuthority(value: unknown): OperationsAuthorityRef {
  const obj = record(value, "operationsAuthority");
  exact(obj, ["packId", "packDigest", "actionId", "actionDescriptorDigest"]);
  return { packId: textValue(obj.packId, "operationsAuthority.packId"), packDigest: digest(obj.packDigest, "operationsAuthority.packDigest"),
    actionId: textValue(obj.actionId, "operationsAuthority.actionId"), actionDescriptorDigest: digest(obj.actionDescriptorDigest, "operationsAuthority.actionDescriptorDigest") };
}

/** Parse one prepared immutable input and its optional selection rationale. */
function parseInput(value: unknown, index: number): OperationInputRef {
  const obj = record(value, `inputs[${index}]`);
  exact(obj, ["id", "provenance", "digest", "byteCount", "selected"], ["rationaleDigest"]);
  const rationaleDigest = obj.rationaleDigest === undefined ? undefined : digest(obj.rationaleDigest, "input rationaleDigest");
  if (obj.selected === true && rationaleDigest === undefined) throw new Error("selected input requires rationaleDigest");
  return { id: textValue(obj.id, "input id"), provenance: textValue(obj.provenance, "input provenance"), digest: digest(obj.digest, "input digest"),
    byteCount: count(obj.byteCount, "input byteCount"), selected: booleanValue(obj.selected, "input selected"), ...(rationaleDigest === undefined ? {} : { rationaleDigest }) };
}

/** Parse one immutable preparation-evidence reference, never a transcript. */
function parseEvidence(value: unknown, index: number): PreparationEvidenceRef {
  const obj = record(value, `preparationEvidence[${index}]`);
  exact(obj, ["type", "provenance", "digest", "byteCount"], ["payloadRef"]);
  const declaredDigest = digest(obj.digest, "evidence digest");
  const payload = obj.payloadRef === undefined ? undefined : payloadRef(obj.payloadRef, "evidence payloadRef");
  if (payload !== undefined && declaredDigest !== `sha256:${payload}`) {
    throw new Error("evidence digest must bind its payloadRef");
  }
  return { type: textValue(obj.type, "evidence type"), provenance: textValue(obj.provenance, "evidence provenance"), digest: declaredDigest,
    byteCount: count(obj.byteCount, "evidence byteCount"), ...(payload === undefined ? {} : { payloadRef: payload }) };
}

/** Parse one declared resource bound. */
function parseBound(value: unknown, index: number): OperationBound {
  const obj = record(value, `bounds[${index}]`);
  exact(obj, ["name", "unit", "maximum"]);
  const unit = enumValue(obj.unit, ["bytes", "count", "milliseconds"] as const, "bound unit");
  return { name: textValue(obj.name, "bound name"), unit, maximum: count(obj.maximum, "bound maximum") };
}

/** Parse and cross-check host-authored preparation completeness counts. */
function parseCompleteness(value: unknown): OperationCompleteness {
  const obj = record(value, "completeness");
  exact(obj, ["attempted", "completed", "skipped", "failed", "requiredMissing", "optionalMissing", "rationaleDigest"]);
  const result = { attempted: count(obj.attempted, "completeness attempted"),
    completed: count(obj.completed, "completeness completed"),
    skipped: count(obj.skipped, "completeness skipped"), failed: count(obj.failed, "completeness failed"), requiredMissing: count(obj.requiredMissing, "completeness requiredMissing"),
    optionalMissing: count(obj.optionalMissing, "completeness optionalMissing"), rationaleDigest: digest(obj.rationaleDigest, "completeness rationaleDigest"),
  };
  if (result.attempted !== result.completed + result.skipped + result.failed) {
    throw new Error("completeness counts are inconsistent");
  }
  return result;
}

/** Parse one reviewable reconciliation decision. */
function parseReconciliation(value: unknown, index: number): OperationReconciliation {
  const obj = record(value, `reconciliations[${index}]`);
  exact(obj, ["id", "findingDigest", "resolution", "rationaleDigest"]);
  const choices = ["create-distinct", "update-existing", "merge-evidence", "reject-candidate", "supersede-candidate", "retarget-relations"] as const;
  return { id: textValue(obj.id, "reconciliation id"), findingDigest: digest(obj.findingDigest, "reconciliation findingDigest"),
    resolution: enumValue(obj.resolution, choices, "reconciliation resolution") as ReconciliationResolution, rationaleDigest: digest(obj.rationaleDigest, "reconciliation rationaleDigest") };
}

/** Parse one bounded, non-executable planning warning. */
function parseWarning(value: unknown, index: number): OperationPlanningWarning {
  const obj = record(value, `planningWarnings[${index}]`);
  exact(obj, ["code", "message"]);
  return { code: textValue(obj.code, "warning code"), message: textValue(obj.message, "warning message", MAX_MESSAGE_BYTES) };
}

/** Parse every mutation, then enforce cross-mutation topology and references. */
function parseMutations(value: unknown, bundleId: BundleId, reconciliations: OperationReconciliation[]): OperationMutation[] {
  const items = array(value, "mutations", MAX_MUTATIONS_PER_BUNDLE);
  const reconciliationIds = new Set(reconciliations.map((item) => item.id));
  const parsed = items.map((item, index) => parseMutation(item, index, bundleId));
  for (const item of parsed) {
    if (item.reconciliationRefs.some((id) => !reconciliationIds.has(id))) {
      throw new Error("mutation references unknown reconciliation");
    }
    if (item.kind !== "projection" && item.dependsOn.some((index) => parsed[index]?.kind === "projection")) {
      throw new Error("authoritative mutation cannot depend on projection");
    }
  }
  validateProjectionAliases(parsed);
  return parsed;
}

/** Reject duplicate or ancestor projection leaves within one recipe root. */
function validateProjectionAliases(mutations: readonly OperationMutation[]): void {
  const byRecipe = new Map<string, { targets: Set<string>; ancestors: Set<string> }>();
  for (const item of mutations) {
    if (item.kind !== "projection") continue;
    const index = byRecipe.get(item.target.recipeId) ?? { targets: new Set(), ancestors: new Set() };
    const output = item.target.output, segments = output.split("/");
    const ancestors = segments.slice(0, -1).map((_, offset) => segments.slice(0, offset + 1).join("/"));
    if (index.targets.has(output) || index.ancestors.has(output)
      || ancestors.some((ancestor) => index.targets.has(ancestor))) {
      throw new Error("projection target alias or ancestor collision");
    }
    index.targets.add(output);
    for (const ancestor of ancestors) index.ancestors.add(ancestor);
    byRecipe.set(item.target.recipeId, index);
  }
}

/** Parse the common mutation envelope and dispatch its closed kind grammar. */
function parseMutation(value: unknown, index: number, bundleId: BundleId): OperationMutation {
  const obj = record(value, `mutations[${index}]`);
  exact(obj, ["index", "mutationId", "kind", "operation", "target", "precondition", "postcondition", "dependsOn", "reconciliationRefs"], mutationOptionalFields(obj.kind));
  if (obj.index !== index) throw new Error("mutation indexes must be contiguous from zero");
  const expectedId = mutationId(bundleId, index);
  if (obj.mutationId !== expectedId) throw new Error("mutationId does not match its derived identity");
  const envelope = { index, mutationId: expectedId, dependsOn: dependencies(obj.dependsOn, index), reconciliationRefs: stringArray(obj.reconciliationRefs, "reconciliationRefs") };
  return parseMutationKind(obj, envelope);
}

/** Return the only optional fields legal for one declared mutation kind. */
function mutationOptionalFields(kind: unknown): readonly string[] {
  if (kind === "relation") return ["attributes", "evidence"];
  if (kind === "lifecycle-transition") return ["evidence"];
  if (kind === "source-retain" || kind === "page" || kind === "artifact" || kind === "catalog-record") return ["payloadRef"];
  return kind === "projection" ? [] : ["payloadRef"];
}

/** Dispatch only the seven launch kinds; every other kind remains deferred. */
function parseMutationKind(obj: JsonRecord, envelope: MutationEnvelope): OperationMutation {
  switch (obj.kind) {
    case "source-retain": return parseSource(obj, envelope);
    case "page": return parsePage(obj, envelope);
    case "relation": return parseRelation(obj, envelope);
    case "lifecycle-transition": return parseLifecycle(obj, envelope);
    case "artifact": return parseArtifact(obj, envelope);
    case "catalog-record": return parseCatalog(obj, envelope);
    case "projection": return parseProjection(obj, envelope);
    default: throw new Error("unsupported operation mutation kind");
  }
}

type MutationEnvelope = Pick<OperationMutation, "index" | "mutationId" | "dependsOn" | "reconciliationRefs">;

/** Parse create-only retained-source intent with digest-derived identity. */
function parseSource(obj: JsonRecord, base: MutationEnvelope): SourceRetainMutation {
  operation(obj, ["create"], "source-retain");
  const target = parseTarget(obj.target, ["digest"], "source target");
  const payload = payloadRef(obj.payloadRef, "source payloadRef");
  const precondition = byteState(obj.precondition, "absent-or-same", "source precondition");
  const postcondition = bytePost(obj.postcondition, "source postcondition");
  if (target.digest !== payload || precondition.digest !== `sha256:${payload}` || postcondition.digest !== `sha256:${payload}`) {
    throw new Error("source digest fields must bind the payloadRef");
  }
  if (precondition.byteCount !== postcondition.byteCount) throw new Error("source byteCount fields differ");
  return { ...base, kind: "source-retain", operation: "create", target: { digest: payload }, payloadRef: payload, precondition, postcondition };
}

/** Parse page create/update/delete intent with exact current and future bytes. */
function parsePage(obj: JsonRecord, base: MutationEnvelope): PageOperationMutation {
  const selected = operation(obj, ["create", "update", "delete"] as const, "page");
  const target = pageTarget(obj.target);
  const payload = payloadRef(obj.payloadRef, "page payloadRef");
  // A DELETE, like an update, must say WHICH bytes it expects to remove — an
  // absent precondition would let it destroy a page that changed since the
  // proposal, which is the whole reason the precondition exists.
  const precondition = selected === "create"
    ? absent(obj.precondition, "page precondition")
    : digestState(obj.precondition, "page precondition");
  // A delete's postcondition is the SAME absent shape a create's precondition
  // uses, parsed by the same function — one definition of "declares absence".
  const postcondition = selected === "delete"
    ? absent(obj.postcondition, "page postcondition")
    : bytePost(obj.postcondition, "page postcondition");
  return { ...base, kind: "page", operation: selected, target, payloadRef: payload, precondition, postcondition };
}

/** Parse the planner's existing typed/raw page target union without coercion. */
function pageTarget(value: unknown): PageOperationMutation["target"] {
  const obj = record(value, "page target");
  if (obj.kind === "entity") {
    exact(obj, ["kind", "entityType", "slug"]);
    return { kind: "entity", entityType: slugSafe(obj.entityType, "page entityType"), slug: slugSafe(obj.slug, "page slug") };
  }
  exact(obj, ["kind", "directory", "slug"]);
  if (obj.kind !== "raw") throw new Error("page target kind is unsupported");
  const directory = safeRawComponent(obj.directory, "page directory"), slug = safeRawComponent(obj.slug, "page slug");
  return { kind: "raw", directory, slug };
}

/** Parse append-shaped relation intent without arbitrary payload bytes. */
function parseRelation(obj: JsonRecord, base: MutationEnvelope): RelationOperationMutation {
  const selected = operation(obj, ["create", "supersede", "retarget"] as const, "relation");
  const target = relationTarget(obj.target, selected);
  const attributes = obj.attributes === undefined ? {} : boundedDataObject(obj.attributes, "relation attributes");
  const evidence = obj.evidence === undefined ? undefined : relationEvidence(obj.evidence);
  const precondition = selected === "create" ? absent(obj.precondition, "relation precondition") : recordState(obj.precondition, "relation precondition");
  if (precondition.kind === "record" && target.relationId !== precondition.recordId) throw new Error("relation prior identity mismatch");
  return { ...base, kind: "relation", operation: selected, target, attributes,
    ...(evidence === undefined ? {} : { evidence }), precondition,
    postcondition: recordPost(obj.postcondition, "relation postcondition") };
}

/** Rebuild citation evidence through the relation store's shared validator. */
function relationEvidence(value: unknown): CitationRef[] {
  if (!Array.isArray(value)) throw new Error("relation evidence is invalid: expected an array");
  const problems = validateRelationEvidence(value as CitationRef[]);
  if (problems.length > 0) throw new Error(`relation evidence is invalid: ${problems[0]}`);
  return value.map((item, index) => {
    const obj = record(item, `relation evidence[${index}]`);
    exact(obj, ["sourcePath"], ["sourceSpan"]);
    const sourceSpan = obj.sourceSpan === undefined ? undefined : textValue(obj.sourceSpan, "relation sourceSpan");
    return { sourcePath: textValue(obj.sourcePath, "relation sourcePath"),
      ...(sourceSpan === undefined ? {} : { sourceSpan }) };
  });
}

/** Parse one declared lifecycle state transition. */
function parseLifecycle(obj: JsonRecord, base: MutationEnvelope): LifecycleOperationMutation {
  operation(obj, ["transition"], "lifecycle-transition");
  const pre = record(obj.precondition, "lifecycle precondition");
  const post = record(obj.postcondition, "lifecycle postcondition");
  exact(pre, ["kind", "state", "pageDigest"]);
  exact(post, ["state", "pageDigest", "eventDigest"]);
  if (pre.kind !== "state") throw new Error("lifecycle precondition kind must be state");
  const evidence = obj.evidence === undefined ? undefined : boundedDataObject(obj.evidence, "lifecycle evidence");
  return { ...base, kind: "lifecycle-transition", operation: "transition", target: entityTarget(obj.target, "lifecycle target"),
    ...(evidence === undefined ? {} : { evidence }),
    precondition: { kind: "state", state: textValue(pre.state, "lifecycle state"), pageDigest: digest(pre.pageDigest, "lifecycle pageDigest") },
    postcondition: { state: textValue(post.state, "lifecycle state"), pageDigest: digest(post.pageDigest, "lifecycle pageDigest"), eventDigest: digest(post.eventDigest, "lifecycle eventDigest") } };
}

/** Parse create-only artifact intent and its three-part observation contract. */
function parseArtifact(obj: JsonRecord, base: MutationEnvelope): ArtifactOperationMutation {
  operation(obj, ["create"], "artifact");
  const target = parseTarget(obj.target, ["artifactType", "logicalId"], "artifact target");
  const post = record(obj.postcondition, "artifact postcondition");
  exact(post, ["digest", "manifestDigest", "auditDigest"]);
  return { ...base, kind: "artifact", operation: "create", target: { artifactType: slugSafe(target.artifactType, "artifact type"), logicalId: slugSafe(target.logicalId, "artifact logicalId") },
    payloadRef: payloadRef(obj.payloadRef, "artifact payloadRef"), precondition: absent(obj.precondition, "artifact precondition"),
    postcondition: { digest: digest(post.digest, "artifact digest"), manifestDigest: digest(post.manifestDigest, "artifact manifestDigest"), auditDigest: digest(post.auditDigest, "artifact auditDigest") } };
}

/** Parse append-only catalog create or supersession intent. */
function parseCatalog(obj: JsonRecord, base: MutationEnvelope): CatalogOperationMutation {
  const selected = operation(obj, ["create", "supersede"] as const, "catalog-record");
  const target = parseTarget(obj.target, ["logicalRecordId"], "catalog target", ["supersedesRecordId"]);
  const supersedesRecordId = target.supersedesRecordId === undefined
    ? undefined : assertCatalogRecordId(target.supersedesRecordId);
  if ((selected === "supersede") !== (supersedesRecordId !== undefined)) throw new Error("catalog supersession target mismatch");
  const parsedTarget = { logicalRecordId: safeRawComponent(target.logicalRecordId, "catalog logicalRecordId"), ...(supersedesRecordId === undefined ? {} : { supersedesRecordId }) };
  const precondition = selected === "create"
    ? absent(obj.precondition, "catalog precondition") : catalogRecordState(obj.precondition);
  if (precondition.kind === "record" && supersedesRecordId !== precondition.recordId) throw new Error("catalog prior identity mismatch");
  return { ...base, kind: "catalog-record", operation: selected, target: parsedTarget, payloadRef: payloadRef(obj.payloadRef, "catalog payloadRef"),
    precondition, postcondition: catalogRecordPost(obj.postcondition, base.mutationId) };
}

/** Parse post-authority projection intent within one recipe-relative root. */
function parseProjection(obj: JsonRecord, base: MutationEnvelope): ProjectionOperationMutation {
  forbidPayload(obj, "projection");
  operation(obj, ["render"], "projection");
  const target = parseTarget(obj.target, ["recipeId", "recipeDigest", "output", "criticality"], "projection target");
  return { ...base, kind: "projection", operation: "render", target: { recipeId: assertRecipeId(target.recipeId),
    recipeDigest: digest(target.recipeDigest, "projection recipeDigest"),
    output: assertProjectionRelativeOutput(target.output),
    criticality: enumValue(target.criticality, ["required", "optional"] as const, "projection criticality") },
    precondition: absentOrDigest(obj.precondition, "projection precondition"), postcondition: digestPost(obj.postcondition, "projection postcondition") };
}

/** Parse an entity-type/slug target without treating either identity as a path. */
function entityTarget(value: unknown, label: string): { entityType: string; slug: string } {
  const obj = parseTarget(value, ["entityType", "slug"], label);
  return { entityType: slugSafe(obj.entityType, `${label} entityType`), slug: slugSafe(obj.slug, `${label} slug`) };
}

/** Parse relation endpoints and require a prior identity for mutations. */
function relationTarget(value: unknown, selected: RelationOperationMutation["operation"]): RelationOperationMutation["target"] {
  const obj = parseTarget(value, ["relationType", "from", "to"], "relation target", ["relationId"]);
  const relationId = obj.relationId === undefined ? undefined : safeRawComponent(obj.relationId, "relation id");
  if ((selected !== "create") !== (relationId !== undefined)) throw new Error("relation prior identity mismatch");
  return { relationType: slugSafe(obj.relationType, "relation type"), from: entityEndpoint(obj.from), to: entityEndpoint(obj.to),
    ...(relationId === undefined ? {} : { relationId }) };
}

/** Parse an exact kind-specific target object. */
function parseTarget(value: unknown, required: readonly string[], label: string, optional: readonly string[] = []): JsonRecord {
  const obj = record(value, label);
  exact(obj, required, optional);
  return obj;
}

/** Parse an absent precondition. */
function absent(value: unknown, label: string): { kind: "absent" } {
  const obj = record(value, label);
  exact(obj, ["kind"]);
  if (obj.kind !== "absent") throw new Error(`${label} kind must be absent`);
  return { kind: "absent" };
}

/** Parse an absent or exact-digest precondition. */
function absentOrDigest(value: unknown, label: string): ProjectionOperationMutation["precondition"] {
  const obj = record(value, label);
  return obj.kind === "absent" ? absent(obj, label) : digestState(obj, label);
}

/** Parse an exact-digest precondition. */
function digestState(value: unknown, label: string): { kind: "digest"; digest: OperationDigest } {
  const obj = record(value, label);
  exact(obj, ["kind", "digest"]);
  if (obj.kind !== "digest") throw new Error(`${label} kind must be digest`);
  return { kind: "digest", digest: digest(obj.digest, `${label} digest`) };
}

/** Parse an append-record precondition. */
function recordState(value: unknown, label: string): { kind: "record"; recordId: string; digest: OperationDigest } {
  const obj = record(value, label);
  exact(obj, ["kind", "recordId", "digest"]);
  if (obj.kind !== "record") throw new Error(`${label} kind must be record`);
  return { kind: "record", recordId: safeRawComponent(obj.recordId, `${label} recordId`), digest: digest(obj.digest, `${label} digest`) };
}

/** Parse byte count plus digest with a fixed precondition discriminator. */
function byteState(value: unknown, kind: "absent-or-same", label: string): SourceRetainMutation["precondition"] {
  const obj = record(value, label);
  exact(obj, ["kind", "digest", "byteCount"]);
  if (obj.kind !== kind) throw new Error(`${label} kind must be ${kind}`);
  return { kind, digest: digest(obj.digest, `${label} digest`), byteCount: count(obj.byteCount, `${label} byteCount`) };
}

/** Parse an exact future byte state. */
function bytePost(value: unknown, label: string): { digest: OperationDigest; byteCount: number } {
  const obj = record(value, label);
  exact(obj, ["digest", "byteCount"]);
  return { digest: digest(obj.digest, `${label} digest`), byteCount: count(obj.byteCount, `${label} byteCount`) };
}

/** Parse an append-shaped future record identity. */
function recordPost(value: unknown, label: string): { digest: OperationDigest; recordId: string } {
  const obj = record(value, label);
  exact(obj, ["digest", "recordId"]);
  return { digest: digest(obj.digest, `${label} digest`), recordId: safeRawComponent(obj.recordId, `${label} recordId`) };
}

/** Parse a catalog predecessor through the shared physical-record grammar. */
function catalogRecordState(value: unknown): Extract<CatalogOperationMutation["precondition"], { kind: "record" }> {
  const obj = record(value, "catalog precondition");
  exact(obj, ["kind", "recordId", "digest"]);
  if (obj.kind !== "record") throw new Error("catalog precondition kind must be record");
  return { kind: "record", recordId: assertCatalogRecordId(obj.recordId),
    digest: digest(obj.digest, "catalog precondition digest") };
}

/** Bind a catalog future record to the current mutation's derived identity. */
function catalogRecordPost(value: unknown, mutation: MutationId): CatalogOperationMutation["postcondition"] {
  const obj = record(value, "catalog postcondition");
  exact(obj, ["digest", "recordId"]);
  const recordId = assertCatalogRecordId(obj.recordId);
  if (recordId !== catalogRecordId(mutation)) throw new Error("catalog postcondition recordId is not derived from mutationId");
  return { digest: digest(obj.digest, "catalog postcondition digest"), recordId };
}

/** Parse a future digest-only state. */
function digestPost(value: unknown, label: string): { digest: OperationDigest } {
  const obj = record(value, label);
  exact(obj, ["digest"]); return { digest: digest(obj.digest, `${label} digest`) };
}

/** Parse and validate a kind-specific operation literal. */
function operation<const T extends readonly string[]>(obj: JsonRecord, allowed: T, label: string): T[number] {
  return enumValue(obj.operation, allowed, `${label} operation`); }

/** Reject payload bytes for append/declarative/render mutation kinds. */
function forbidPayload(obj: JsonRecord, label: string): void {
  if (obj.payloadRef !== undefined) throw new Error(`${label} payloadRef is forbidden`); }

/** Parse unique backward-only dependency indexes. */
function dependencies(value: unknown, mutationIndex: number): number[] {
  const items = array(value, "mutation dependency", MAX_MUTATIONS_PER_BUNDLE);
  const parsed = items.map((item) => count(item, "mutation dependency"));
  if (new Set(parsed).size !== parsed.length || parsed.some((item) => item >= mutationIndex)) {
    throw new Error("mutation dependency must be unique and backward-only");
  }
  return parsed;
}

/** Parse a bounded unique string list. */
function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label, MAX_LIST_ITEMS).map((item) => textValue(item, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
}

/** Reuse the typed-page identity grammar without minting an ID during parse. */
function slugSafe(value: unknown, label: string): string {
  return validatedText(value, label, isSlugSafe); }

/** Reuse the raw-page identity floor after applying manifest string bounds. */
function safeRawComponent(value: unknown, label: string): string {
  return validatedText(value, label, isSafeFilenameComponent); }

/** Apply one existing identity predicate after the manifest string bound. */
function validatedText(value: unknown, label: string, predicate: (item: string) => boolean): string {
  const result = textValue(value, label);
  if (!predicate(result)) throw new Error(`${label} is invalid`);
  return result;
}

/** Reuse the entity-id parser for relation endpoints and expose fixed errors. */
function entityEndpoint(value: unknown): string {
  const result = textValue(value, "relation endpoint");
  try { parseEntityId(result as EntityId); } catch { throw new Error("relation endpoint is invalid"); } return result;
}
