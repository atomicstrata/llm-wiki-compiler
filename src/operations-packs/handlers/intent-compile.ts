/**
 * @file src/operations-packs/handlers/intent-compile.ts
 * @description The intent-compile host-handler family (design section 16.7): a
 * PURE translation of validated proposal evidence into typed Milestone A mutation
 * DRAFT proposals. It emits NO direct write, derives NO path from pack or provider
 * text, and rejects deferred mutation kinds. Every draft field is resolved through
 * a CLOSED field mapping that may only select a named phase input, a bounded
 * constant, or a host-derived identity — never a concatenated writable path, a
 * provider call, or arbitrary mutation JSON, none of which the mapping union can
 * represent. Each draft carries a canonical payload digest and the whole result
 * carries the Orchestration V2 handoff-capacity envelope.
 *
 * RESOLVED FROM PROSE (section 16.7). The launch mutation kinds are the five closed
 * Milestone A kinds; any other kind is refused as deferred. A draft is a closed
 * typed record — mutation kind, target profile class, resolved scalar fields, and a
 * payload digest — with no free-form JSON field and no path field, so a store path
 * is derivable only by the owning adapter downstream, never here.
 */

import { createHash } from "node:crypto";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { PackDeferredError } from "../problems.js";
import { capItems, enforceOutputBytes, stableSortByKey } from "./evidence.js";
import { PackHostHandlerError } from "./types.js";
import { CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD } from "../runtime/store-snapshot.js";
import { isSlugName } from "../ids.js";
import type { IntentFieldMappingV2, IntentGroupV2, PackProjectionV2 } from "../recipe-types.js";
import { draftPayloadBytes } from "./page-payload.js";
import type {
  PackEvidenceItemV1, PackEvidenceScalarV1, PackHostIdentitiesV1, PackIntentDraftV1,
  PackIntentInputV1, PackIntentMutationKindV1, PackIntentResultV1,
} from "./types.js";

/**
 * The closed launch Milestone A mutation kinds (section 16.7).
 *
 * `artifact-update` joined them once the bundle grammar's existing page
 * `update` operation could be authored with a real precondition — the digest
 * of the bytes the draft was computed against. Before that it would have had to
 * be a blind overwrite, which is why it was not admitted earlier.
 */
const LAUNCH_MUTATION_KINDS: ReadonlySet<string> = new Set([
  "artifact-upsert", "artifact-update", "artifact-delete", "catalog-append", "projection-register",
  "relation-upsert",
  "lifecycle-transition",
]);

/** Fail closed (deferred) unless the requested mutation kind is a launch kind. */
function assertLaunchMutationKind(kind: string): PackIntentMutationKindV1 {
  if (!LAUNCH_MUTATION_KINDS.has(kind)) throw new PackDeferredError(`intent mutation kind is deferred: ${kind}`);
  return kind as PackIntentMutationKindV1;
}

/** Resolve one host-derived identity value by its closed identity kind. */
function hostIdentityValue(identityKind: "run-id" | "principal" | "host-timestamp", identities: PackHostIdentitiesV1): string {
  if (identityKind === "run-id") return identities.runId;
  if (identityKind === "principal") return identities.principal;
  return identities.hostTimestamp;
}

/** Resolve one closed field mapping to a scalar; a missing bound input fails closed. */
function resolveMapping(mapping: IntentFieldMappingV2, item: PackEvidenceItemV1, identities: PackHostIdentitiesV1): PackEvidenceScalarV1 {
  if (mapping.source === "constant") return mapping.value;
  if (mapping.source === "host-identity") return hostIdentityValue(mapping.identityKind, identities);
  const value = item.fields[mapping.ref];
  if (value === undefined) throw new PackHostHandlerError(`intent mapping is missing bound input ${mapping.ref}`);
  return value;
}

/** Build one draft's resolved field record from one group's closed field mappings. */
function draftFields(group: IntentGroupV2, item: PackEvidenceItemV1, identities: PackHostIdentitiesV1): Readonly<Record<string, PackEvidenceScalarV1>> {
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const mapping of group.fieldMappings) {
    fields[mapping.targetField] = resolveMapping(mapping, item, identities);
  }
  return fields;
}

/**
 * The write shape one group produces: its own class and list hint, or the
 * projection's when it names one.
 *
 * A GROUP NAMING A PROJECTION DOES NOT RE-MAP. The evidence it receives has
 * already been canonicalized by the reconcile phase that shares the projection,
 * so each target field is taken off the item of the same name. Applying the
 * mapping a second time would look for source fields the first application
 * consumed — and re-declaring it here is exactly the duplication that let the
 * comparison and the write drift apart.
 */
function writeShape(
  group: IntentGroupV2, item: PackEvidenceItemV1, identities: PackHostIdentitiesV1,
  projections: Readonly<Record<string, PackProjectionV2>> | undefined,
): WriteShapeV1 {
  if (group.projectionRef === undefined) {
    return {
      targetProfileClass: group.targetProfileClass,
      fields: draftFields(group, item, identities),
      ...(group.listFields === undefined ? {} : { listFields: group.listFields }),
    };
  }
  const projection = projections?.[group.projectionRef];
  if (projection === undefined) {
    throw new PackHostHandlerError(`intent group names unresolved projection ${group.projectionRef}`);
  }
  // A projection's targets take the PAGE vocabulary (camelCase profile fields
  // included), and this substitution applies to EVERY mutation kind — so a
  // relation group naming a page-shaped projection would otherwise persist a
  // camelCase relation attribute, which is exactly the vocabulary the relation
  // draft shape is kept slug-only to prevent. Enforced HERE because the group
  // parser cannot see the projection it names.
  if (!PAGE_DRAFT_KINDS.has(group.mutationKind)) {
    for (const mapping of projection.fieldMappings) {
      if (!isSlugName(mapping.targetField)) {
        throw new PackHostHandlerError(
          `a ${group.mutationKind} group may not name a projection whose target ${mapping.targetField} is not a slug`);
      }
    }
  }
  return {
    targetProfileClass: projection.targetProfileClass,
    fields: canonicalFields(projection, item),
    ...(projection.listFields === undefined ? {} : { listFields: projection.listFields }),
  };
}

/** Mutation kinds whose draft becomes a PAGE (see handlers/page-payload). */
const PAGE_DRAFT_KINDS: ReadonlySet<string> = new Set([
  "artifact-upsert", "artifact-update", "artifact-delete",
]);

/** The class, fields and list hint one draft is written from. */
interface WriteShapeV1 {
  readonly targetProfileClass: string;
  readonly fields: Readonly<Record<string, PackEvidenceScalarV1>>;
  readonly listFields?: readonly string[];
}

/** Read each of a projection's target fields off already-projected evidence. */
function canonicalFields(
  projection: PackProjectionV2, item: PackEvidenceItemV1,
): Readonly<Record<string, PackEvidenceScalarV1>> {
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const mapping of projection.fieldMappings) {
    const value = item.fields[mapping.targetField];
    if (value === undefined) {
      throw new PackHostHandlerError(`projected evidence is missing canonical field ${mapping.targetField}`);
    }
    fields[mapping.targetField] = value;
  }
  return fields;
}

/**
 * The on-disk identity an update draft was computed against.
 *
 * Refuses when the evidence does not carry it: an update whose precondition
 * cannot be sourced would have to be authored as a blind overwrite, and a blind
 * overwrite of a page the operator never saw is exactly what the precondition
 * exists to prevent.
 */
function expectedCurrentOf(
  item: PackEvidenceItemV1,
): { readonly digest: string; readonly byteCount: number } {
  const digest = item.fields[CURRENT_DIGEST_FIELD];
  const byteCount = item.fields[CURRENT_BYTES_FIELD];
  if (typeof digest !== "string" || typeof byteCount !== "number") {
    throw new PackHostHandlerError(
      "a destructive page draft has no current-page digest to use as its precondition;"
      + " it must be compiled from evidence that flowed through a reconcile phase");
  }
  return { digest, byteCount };
}

/** Compile one proposal item under one intent group into a typed mutation draft (16.7). */
function compileDraft(
  group: IntentGroupV2, item: PackEvidenceItemV1, mutationKind: PackIntentMutationKindV1,
  identities: PackHostIdentitiesV1,
  projections: Readonly<Record<string, PackProjectionV2>> | undefined,
): PackIntentDraftV1 {
  const shape = writeShape(group, item, identities, projections);
  const fields = shape.fields;
  // A page draft's payload IS the formatted page (frontmatter + body), so the
  // digest published here is the content address of the bytes the store will
  // write and the profile will read back; other kinds digest the canonical
  // draft record their mutations carry inline. One rule: draftPayloadBytes.
  const payloadDigest = `sha256:${createHash("sha256").update(draftPayloadBytes({
    mutationKind, targetProfileClass: shape.targetProfileClass, fields,
    ...(shape.listFields === undefined ? {} : { listFields: [...shape.listFields] }),
  })).digest("hex")}`;
  // An UPDATE carries the on-disk identity it was computed against, taken from
  // the reconcile snapshot that flowed through this phase's evidence. Without
  // it the materializer could only author an absent-precondition create.
  // BOTH destructive page kinds carry the on-disk identity they were computed
  // against: an update to avoid clobbering a changed page, a delete to avoid
  // removing one.
  const expected = mutationKind === "artifact-update" || mutationKind === "artifact-delete"
    ? expectedCurrentOf(item)
    : undefined;
  return {
    ...(expected === undefined ? {} : { expectedCurrent: expected }),
    // THE SHAPE'S list fields, not the group's. The payload digest above is
    // computed from `shape`, so returning the group's would let a pack relying
    // solely on its PROJECTION's list fields publish a draft whose materializer
    // recomputation refuses — a digest and a draft describing different pages.
    ...(shape.listFields === undefined ? {} : { listFields: [...shape.listFields] }),
    sourceItemId: item.itemId, mutationKind, targetProfileClass: shape.targetProfileClass, fields,
    payloadDigest,
  };
}

/**
 * The items one group drafts over: every evidence item by default, only those
 * carrying a field non-empty when the group declares `whenPresent`, or only
 * those whose field EQUALS a declared value when it declares `whenEquals`.
 *
 * Presence is how a terminal drafts a projection page from the render output
 * item alone; equality is how it dispositions a reconciliation verdict, drafting
 * for the identities a comparison classified one way and leaving the colliding
 * ones to a human. Comparison is on the value's string form, because evidence
 * scalars are string/number/boolean and a pack declares its value as text.
 */
function groupItems(group: IntentGroupV2, evidence: readonly PackEvidenceItemV1[]): readonly PackEvidenceItemV1[] {
  // BOTH gates apply when both are declared — a conjunction, per the parser's
  // contract. Filtering sequentially is the AND; an item must survive each
  // declared gate to enter the group.
  const equals = group.whenEquals;
  const field = group.whenPresent;
  let items = evidence;
  if (equals !== undefined) items = items.filter((item) => String(item.fields[equals.field] ?? "") === equals.value);
  if (field !== undefined) items = items.filter((item) => item.fields[field] !== undefined && item.fields[field] !== "");
  return items;
}

/**
 * Compile validated proposal evidence into typed Milestone A mutation-draft
 * proposals (section 16.7). Pure and deterministic: identical input yields
 * identical output bytes. It emits no write and derives no path. A proposal set
 * beyond the item ceiling fails closed; a deferred mutation kind is refused.
 */
export function compileIntents(input: PackIntentInputV1): PackIntentResultV1 {
  capItems(input.evidence, input.bounds.maximumItems, { kind: "fail" });
  const drafts = stableSortByKey(
    input.body.intents.flatMap((group) => {
      const mutationKind = assertLaunchMutationKind(group.mutationKind);
      return groupItems(group, input.evidence)
        .map((item) => compileDraft(group, item, mutationKind, input.identities, input.projections));
    }),
    // One item can legitimately be drafted by several groups, so the stable
    // order keys on the payload digest beside the source identity.
    (draft) => `${draft.sourceItemId}:${draft.payloadDigest}`,
  );
  if (drafts.length > input.bounds.maximumItems) {
    throw new PackHostHandlerError("intent drafts exceed the declared item ceiling");
  }
  const result: PackIntentResultV1 = {
    intentTemplateRef: input.body.intentTemplateRef, drafts,
    handoffCapacity: { maximumDrafts: input.bounds.maximumItems, declaredDrafts: drafts.length, maximumPayloadBytes: input.bounds.maximumOutputBytes },
    deficits: [],
  };
  enforceOutputBytes(result, input.bounds.maximumOutputBytes);
  return result;
}
