/**
 * @file src/relations/relation-contract.ts
 * @description The single, PURE relation-contract validators shared by the WRITE
 * path (planner + store) and the READ surfaces (lint / status / export).
 *
 * Two concerns, both built on the ONE field-contract core
 * ({@link validateFieldsAgainstDefs}) so a relation attribute is checked against
 * exactly the same type/enum/min/max rules as an entity field (DRY):
 *
 *   - {@link validateRelationAttributes}: a relation's `attributes` against its
 *     relation-type def's declared `attributes` (typed) + `requiredAttributes`
 *     (presence). Used at write time so an attribute violating its declared type
 *     never lands on disk.
 *   - {@link validateRelationAgainstProfile}: a STORED relation re-checked against
 *     the CURRENT profile — its type still declared, endpoints still within the
 *     declared `from`/`to` entity sets, and attributes still satisfying the
 *     contract. Used by the read surfaces to reclassify (never delete) records
 *     that the profile has since outgrown.
 *
 * Both are pure (no I/O), never throw, and carry no path context — callers wrap
 * each message into their own error/finding/problem shape.
 */

import { validateFieldsAgainstDefs } from "../profile/field-contract.js";
import { parseEntityId, EntityIdError } from "../profile/identity.js";
import { isSafeRelativeEvidencePath } from "../utils/evidence-path.js";
import type { EntityId, ProfilePack, RelationTypeDef } from "../profile/types.js";
import type { CitationRef, RelationRef } from "./types.js";

/** Hard cap on the number of citations one relation may carry (DoS bound). */
const MAX_RELATION_EVIDENCE = 64;

/** Hard cap on a citation `sourceSpan` length. */
const MAX_SOURCE_SPAN_CHARS = 128;

/** The ONLY keys a {@link CitationRef} may carry (extra/nested keys are rejected). */
const ALLOWED_CITATION_KEYS: ReadonlySet<string> = new Set(["sourcePath", "sourceSpan"]);

/** True when `entry` is a plain (non-array, non-null) object. */
function isPlainObject(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

/** PATH-FREE messages for any key on `entry` outside the {@link ALLOWED_CITATION_KEYS} allowlist. */
function unexpectedKeyReasons(entry: Record<string, unknown>, at: string): string[] {
  return Object.keys(entry)
    .filter((key) => !ALLOWED_CITATION_KEYS.has(key))
    .map((key) => `${at} has unexpected key '${key}'`);
}

/** PATH-FREE messages when `sourcePath` is missing, non-string, or an unsafe relative path. */
function sourcePathReasons(sourcePath: unknown, at: string): string[] {
  if (typeof sourcePath !== "string" || !isSafeRelativeEvidencePath(sourcePath)) {
    return [`${at} sourcePath is missing or an unsafe path`];
  }
  return [];
}

/** PATH-FREE messages when a present `sourceSpan` is non-string or over the length cap. */
function sourceSpanReasons(sourceSpan: unknown, at: string): string[] {
  if (sourceSpan !== undefined && (typeof sourceSpan !== "string" || sourceSpan.length > MAX_SOURCE_SPAN_CHARS)) {
    return [`${at} sourceSpan must be a string within ${MAX_SOURCE_SPAN_CHARS} chars`];
  }
  return [];
}

/**
 * Validate ONE citation, returning PATH-FREE violation messages. The entry must
 * be a plain object carrying ONLY the allowlisted keys; `sourcePath` is required,
 * a string, and a safe project-relative path; `sourceSpan`, if present, is a
 * length-capped string (the declared type — a numeric/object span is rejected).
 * The three independent checks are delegated to tiny validators and concatenated.
 *
 * @param entry - The candidate citation (untrusted shape).
 * @param index - The entry's index, for a stable message prefix.
 * @returns Zero or more PATH-FREE violation messages for this entry.
 */
function validateCitation(entry: unknown, index: number): string[] {
  const at = `evidence[${index}]`;
  if (!isPlainObject(entry)) return [`${at} must be a citation object`];
  return [
    ...unexpectedKeyReasons(entry, at),
    ...sourcePathReasons(entry.sourcePath, at),
    ...sourceSpanReasons(entry.sourceSpan, at),
  ];
}

/**
 * Validate a relation's `evidence` citations, returning the PATH-FREE violation
 * messages (empty when valid). Absent evidence is valid (the field is optional).
 * Each citation must be a plain object carrying ONLY `sourcePath`/`sourceSpan`,
 * with a required SAFE project-relative `sourcePath` and an optional string
 * `sourceSpan`. The array length is capped at {@link MAX_RELATION_EVIDENCE}.
 *
 * Evidence participates in the relation `contentHash` yet was previously NEVER
 * validated — an unvalidated, path-bearing side channel. This is the shared
 * validator the WRITE path (store) and READ re-validation
 * ({@link validateRelationAgainstProfile}) both call, so a citation a write
 * accepts is exactly one a read re-validates (and the published hash is safe).
 *
 * @param evidence - The relation instance's citations (may be absent).
 * @returns Zero or more PATH-FREE evidence-violation messages.
 */
export function validateRelationEvidence(evidence: CitationRef[] | undefined): string[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence)) return ["evidence must be an array of citations"];
  if (evidence.length > MAX_RELATION_EVIDENCE) {
    return [`evidence has too many citations (${evidence.length} > ${MAX_RELATION_EVIDENCE})`];
  }
  return evidence.flatMap((entry, index) => validateCitation(entry, index));
}

/**
 * Validate a relation's `attributes` against its relation-type def: every declared
 * attribute value must satisfy its `FieldDef` (type/enum/min/max), and every name
 * in `requiredAttributes` must be present. An attribute NOT declared by the def is
 * allowed (extra attributes, mirroring entity extra-frontmatter). Returns the
 * PATH-FREE violation messages (empty when the attributes are valid).
 *
 * @param def - The resolved relation-type definition (its `attributes` is the schema).
 * @param attributes - The relation instance's attributes.
 * @returns Zero or more PATH-FREE attribute-violation messages.
 */
export function validateRelationAttributes(
  def: RelationTypeDef,
  attributes: Record<string, unknown>,
): string[] {
  return validateFieldsAgainstDefs(
    attributes,
    def.attributes ?? {},
    def.requiredAttributes ?? [],
    (name) => `missing required attribute '${name}'`,
  );
}

/** True when an EntityId's entity type is in the allowed set for its endpoint side. */
function endpointTypeAllowed(id: EntityId, allowed: string[]): boolean {
  try {
    return allowed.includes(parseEntityId(id).entityType);
  } catch (err) {
    if (err instanceof EntityIdError) return false;
    throw err;
  }
}

/**
 * Resolve the allowed entity-type set for ONE endpoint of a relation. A
 * `directed` relation keeps roles distinct (`from` uses `def.from`, `to` uses
 * `def.to`); a `symmetric` relation has NO inherent from/to, so each endpoint
 * may be any type in `def.from ∪ def.to`. This is the SINGLE source of truth the
 * write path (store/planner) and the read re-validation share, so a relation a
 * write accepts is exactly one a read re-validates — they can never disagree on
 * the same bytes.
 *
 * @param def - The relation-type definition.
 * @returns The allowed entity types for, respectively, the `from` and `to` sides.
 */
function allowedEndpointSets(def: RelationTypeDef): { from: string[]; to: string[] } {
  if (def.direction === "symmetric") {
    const union = [...new Set([...def.from, ...def.to])];
    return { from: union, to: union };
  }
  return { from: def.from, to: def.to };
}

/**
 * Validate a relation's (already-canonical) endpoints against its relation-type
 * def, returning PATH-FREE reasons either endpoint is disallowed (empty when both
 * satisfy the def). For `symmetric` types both endpoints are checked against the
 * combined `def.from ∪ def.to` set (a symmetric edge has no inherent direction);
 * for `directed` types `from`/`to` are checked in declared order.
 *
 * The SHARED endpoint validator: the store and planner call it on the CANONICAL
 * endpoints they are about to persist, and {@link validateRelationAgainstProfile}
 * calls it on the stored canonical endpoints — so write and read AGREE.
 *
 * @param def - The relation-type definition.
 * @param from - The `from` endpoint (in canonical order for symmetric types).
 * @param to - The `to` endpoint (in canonical order for symmetric types).
 * @returns Zero or more PATH-FREE disallowed-endpoint messages.
 */
export function validateRelationEndpoints(
  def: RelationTypeDef,
  from: EntityId,
  to: EntityId,
): string[] {
  const allowed = allowedEndpointSets(def);
  const reasons: string[] = [];
  if (!endpointTypeAllowed(from, allowed.from)) {
    reasons.push(`from endpoint ${from} is not an allowed entity type (expected one of ${allowed.from.join(", ")})`);
  }
  if (!endpointTypeAllowed(to, allowed.to)) {
    reasons.push(`to endpoint ${to} is not an allowed entity type (expected one of ${allowed.to.join(", ")})`);
  }
  return reasons;
}

/**
 * Re-validate a STORED relation against the CURRENT profile, returning the
 * PATH-FREE reasons it is no longer valid (empty when it still satisfies the
 * profile). A relation is invalid when its `type` is no longer declared, an
 * endpoint's entity type is no longer within the def's declared `from`/`to` set,
 * its attributes no longer satisfy the declared field contract, or its `evidence`
 * citations violate the {@link validateRelationEvidence} contract (a stored,
 * hash-bearing relation must carry only safe project-relative citation paths).
 *
 * This NEVER mutates or deletes — it only classifies, so the read surfaces can
 * retain-and-warn (the spec's profile-adaptation policy).
 *
 * @param ref - The stored relation reference.
 * @param profile - The current governing profile pack.
 * @returns Zero or more PATH-FREE reasons the relation is now invalid.
 */
export function validateRelationAgainstProfile(ref: RelationRef, profile: ProfilePack): string[] {
  const def = profile.relations?.[ref.type];
  if (!def) return [`relation type ${JSON.stringify(ref.type)} is no longer declared by the profile`];
  const reasons: string[] = [];
  for (const reason of validateRelationEndpoints(def, ref.from, ref.to)) {
    reasons.push(`relation ${ref.id} ${reason}`);
  }
  reasons.push(...validateRelationAttributes(def, ref.attributes));
  reasons.push(...validateRelationEvidence(ref.evidence));
  return reasons;
}
