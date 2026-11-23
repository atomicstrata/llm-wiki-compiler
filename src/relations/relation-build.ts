/**
 * @file src/relations/relation-build.ts
 * @description Building a relation write WITHOUT writing it: the caller's
 * input shapes, the profile-validated canonical {@link RelationRef} (id and
 * content hash), the patched input of an update, and the audit event input.
 * Shared by the single-file relation store (`./store.ts`, `./operation-write.ts`)
 * and the segmented relation log (`../history/relations-*.ts`); it imports
 * neither, so the segmented log never imports the store that dispatches to it.
 */

import type { AppendEventInput } from "../events/event-build.js";
import type { EventType } from "../events/types.js";
import { validateArtifactRefsAgainstProfile } from "../profile/artifact-ref-validate.js";
import type { EntityId, ProfilePack, RelationTypeDef } from "../profile/types.js";
import { MAX_RELATION_RECORD_BYTES } from "../utils/constants.js";
import { canonicalEndpoints, relationContentHash } from "./digest.js";
import { validateRelationAgainstProfile, validateRelationAttributes, validateRelationEndpoints, validateRelationEvidence } from "./relation-contract.js";
import { serializeRecord } from "./store-record.js";
import { RelationEndpointError, type CitationRef, type RelationRef } from "./types.js";
import { mintRelationId } from "./ulid.js";

/** The caller-supplied content of a new relation (id + hash are derived). */
export interface AppendRelationInput {
  type: string;
  from: EntityId;
  to: EntityId;
  attributes?: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** An in-place attribute/evidence patch applied under an existing relation id. */
export interface UpdateRelationPatch {
  attributes?: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** Look up a relation-type def, failing closed if the type is undeclared. */
function relationDef(profile: ProfilePack, type: string): RelationTypeDef {
  const def = profile.relations?.[type];
  if (!def) {
    throw new RelationEndpointError(`unknown relation type '${type}'`);
  }
  return def;
}

/**
 * Assert a relation's CANONICAL endpoints satisfy the relation-type def via the
 * SHARED {@link validateRelationEndpoints}, throwing on any violation. Called
 * AFTER canonicalization so the WRITE enforces exactly what the READ
 * ({@link validateRelationAgainstProfile}) re-validates on the same stored bytes —
 * for a symmetric type whose `from`-type sorts after its `to`-type, the swap can
 * never produce a record the read surfaces then flag invalid.
 */
function assertCanonicalEndpoints(def: RelationTypeDef, from: EntityId, to: EntityId, type: string): void {
  const reasons = validateRelationEndpoints(def, from, to);
  if (reasons.length > 0) {
    throw new RelationEndpointError(`relation '${type}' ${reasons.join("; ")}`);
  }
}

/**
 * Assert a relation's attributes satisfy the relation-type def's declared
 * contract — required-attribute PRESENCE AND each declared attribute's
 * type/enum/min/max (the SAME field contract entity fields enforce, via
 * {@link validateRelationAttributes}), PLUS the profile-aware artifactRef scope
 * check ({@link validateArtifactRefsAgainstProfile}). Any violation fails closed
 * BEFORE any write, so a relation whose attribute mismatches its declared type —
 * or carries an undeclared/out-of-scope artifact ref — is never appended.
 */
function assertAttributesValid(
  profile: ProfilePack,
  def: RelationTypeDef,
  attributes: Record<string, unknown>,
  type: string,
): void {
  const violations = [
    ...validateRelationAttributes(def, attributes),
    ...validateArtifactRefsAgainstProfile(profile, def.attributes ?? {}, attributes),
  ];
  if (violations.length > 0) {
    throw new RelationEndpointError(`relation '${type}' has invalid attributes: ${violations.join(" ")}`);
  }
}

/**
 * Assert a relation's `evidence` citations satisfy the {@link validateRelationEvidence}
 * contract — each a plain object carrying ONLY `sourcePath`/`sourceSpan`, with a
 * SAFE project-relative `sourcePath` and a string `sourceSpan` (within caps). Any
 * violation fails closed BEFORE any write, so the unvalidated, path-bearing
 * evidence side channel (which feeds the content hash) can never land on disk —
 * the SAME fail-closed boundary attributes/endpoints get, mirrored on the read
 * side by {@link validateRelationAgainstProfile}.
 */
function assertEvidenceValid(evidence: CitationRef[] | undefined, type: string): void {
  const violations = validateRelationEvidence(evidence);
  if (violations.length > 0) {
    throw new RelationEndpointError(`relation '${type}' has invalid evidence: ${violations.join(" ")}`);
  }
}

/**
 * Reject a relation whose serialized on-disk record exceeds
 * {@link MAX_RELATION_RECORD_BYTES}, so attacker-controlled attribute/evidence
 * size cannot grow one record unbounded (nor reach the per-store cap with one
 * line). Throws {@link RelationEndpointError} BEFORE any write.
 */
function assertRecordWithinCap(ref: RelationRef): void {
  const bytes = Buffer.byteLength(serializeRecord(ref), "utf8");
  if (bytes > MAX_RELATION_RECORD_BYTES) {
    throw new RelationEndpointError(
      `relation '${ref.type}' record ${bytes} bytes exceeds the ${MAX_RELATION_RECORD_BYTES}-byte cap`,
    );
  }
}

/**
 * Build the {@link RelationRef}: canonicalize symmetric endpoints FIRST, then
 * validate the CANONICAL endpoints + required attributes + evidence citations
 * against the relation-type def, mint the id (or reuse `existingId` for an update), and
 * compute the content hash. Canonicalize-THEN-validate (FIX #1) means the WRITE
 * enforces exactly what the READ re-validates, so a symmetric edge whose
 * `from`-type sorts after its `to`-type is never written swapped-then-rejected.
 * The serialized record size is capped LAST. NOTHING is written here —
 * validation throwing leaves the store untouched.
 */
export function buildRelationRef(
  profile: ProfilePack,
  input: AppendRelationInput,
  existingId?: RelationRef["id"],
): RelationRef {
  const def = relationDef(profile, input.type);
  const { from, to } = canonicalEndpoints(input.from, input.to, def.direction);
  assertCanonicalEndpoints(def, from, to, input.type);
  const attributes = input.attributes ?? {};
  assertAttributesValid(profile, def, attributes, input.type);
  assertEvidenceValid(input.evidence, input.type);
  const content = { type: input.type, from, to, attributes, evidence: input.evidence };
  const ref: RelationRef = { id: existingId ?? mintRelationId(), ...content, contentHash: relationContentHash(content) };
  assertRecordWithinCap(ref);
  return ref;
}

/** The input that supersedes `existing` under its id with `patch` applied (type and endpoints preserved). */
export function updatedRelationInput(existing: RelationRef, patch: UpdateRelationPatch): AppendRelationInput {
  return {
    type: existing.type, from: existing.from, to: existing.to,
    attributes: patch.attributes ?? existing.attributes, evidence: patch.evidence ?? existing.evidence,
  };
}

/**
 * Build the relation audit event INPUT (no write). Separating the build from the
 * append lets the caller size+store-full PRE-FLIGHT the EXACT event it will later
 * append (the same object, same `at` timestamp), so the relation mutation can fail
 * CLOSED — with nothing committed — when the trailing audit append would exceed the
 * per-record cap or drive the event store past {@link MAX_EVENT_STORE_BYTES}.
 *
 * SIZE-SAFE (no caller-inflatable payload): the payload records ONLY bounded,
 * derived identifiers — the minted `rel_<ULID>` id, the declared `relType`, and
 * the two canonical `EntityId` endpoints. It does NOT serialize the caller's
 * `attributes`/`evidence` (those are size-capped on the relation RECORD via
 * {@link buildRelationRef}'s {@link MAX_RELATION_RECORD_BYTES} check, and never
 * reach this event). The remaining store-full window is the WHOLE-FILE event cap,
 * which the caller's {@link preflightEventAppend} now closes BEFORE the relation
 * record commits.
 */
export function buildRelationEvent(type: EventType, ref: RelationRef, decision?: string): AppendEventInput {
  return {
    type,
    origin: "sdk",
    payload: { id: ref.id, relType: ref.type, from: ref.from, to: ref.to },
    decision,
    at: new Date().toISOString(),
  };
}
