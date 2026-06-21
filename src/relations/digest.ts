/**
 * @file src/relations/digest.ts
 * @description Canonical content hashing for relations. Mirrors
 * `src/profile/digest.ts`: a SHA-256 over the RFC 8785 (JCS) canonicalization
 * of the content fields, so equal content yields an equal hash regardless of
 * key order or whitespace. The hash is the DEDUP KEY (an append matching a live
 * relation's hash is an idempotent no-op). An optimistic-concurrency
 * `preconditionHash` use is reserved for future staged-relation edits.
 *
 * Symmetric-edge canonicalization: for a `symmetric` relation type, the edge
 * (a→b) and (b→a) are the SAME edge, so the endpoints are ordered
 * lexicographically BEFORE hashing — both directions then produce one hash.
 * For a `directed` type the endpoints keep their declared order.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { EntityId } from "../profile/types.js";
import type { RelationContentInput } from "./types.js";

/** The endpoint direction semantics that govern canonicalization. */
export type RelationDirection = "directed" | "symmetric";

/**
 * Order a relation's endpoints for hashing. A `symmetric` edge orders its
 * endpoints lexicographically so (a→b) and (b→a) hash identically; a `directed`
 * edge keeps them as given.
 *
 * @param from - The `from` endpoint id.
 * @param to - The `to` endpoint id.
 * @param direction - The relation type's direction.
 * @returns The endpoints in canonical (hash) order.
 */
export function canonicalEndpoints(
  from: EntityId,
  to: EntityId,
  direction: RelationDirection,
): { from: EntityId; to: EntityId } {
  if (direction === "symmetric" && to < from) {
    return { from: to, to: from };
  }
  return { from, to };
}

/**
 * Compute the canonical content hash of a relation.
 *
 * Returns the lowercase-hex SHA-256 of the RFC 8785 canonicalization of
 * `{type, from, to, attributes, evidence}`. The caller is responsible for
 * passing endpoints already in canonical order (see {@link canonicalEndpoints})
 * so symmetric duplicates collapse to one hash.
 *
 * @param input - The relation content fields.
 * @returns Lowercase hex SHA-256 of the canonical JSON form.
 */
export function relationContentHash(input: RelationContentInput): string {
  const content = {
    type: input.type,
    from: input.from,
    to: input.to,
    attributes: input.attributes,
    evidence: input.evidence,
  };
  const canonical = canonicalize(content);
  if (canonical === undefined) {
    throw new Error("relation canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
