/**
 * @file src/events/event-digest.ts
 * @description The chain digest for the event store. Mirrors the relation
 * digest's canonicalize-then-sha256 pattern: a SHA-256 over the RFC 8785 (JCS)
 * canonicalization of an event's CONTENT fields (`{id,type,origin,payload,
 * decision,at}`), so equal content yields an equal hash regardless of key order.
 *
 * This digest is the link material of the hash chain: the digest of record[i] is
 * written verbatim into record[i+1].prevHash (the genesis record's prevHash is
 * the fixed {@link GENESIS_PREV_HASH}, not a digest). A reader recomputes each
 * record's digest and checks the successor's `prevHash` against it; any edit,
 * reorder, or deletion of a record changes its digest and breaks the link.
 *
 * The digest intentionally covers the CONTENT (not `prevHash`/`checksum`): the
 * chain link is the content's identity, and including `prevHash` would make the
 * digest self-referential across records without adding tamper coverage that the
 * successor's `prevHash` comparison does not already provide.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { EventContent } from "./types.js";

/**
 * Compute the canonical chain digest of an event's content fields.
 *
 * Returns the lowercase-hex SHA-256 of the RFC 8785 canonicalization of
 * `{id,type,origin,payload,decision,at}`. The result is what the NEXT
 * record carries as its `prevHash`, and what {@link verifyHeadAnchor} compares
 * the sealed head against for the LAST record.
 *
 * @param content - The event's content fields.
 * @returns Lowercase hex SHA-256 of the canonical JSON form.
 */
export function eventPrevHash(content: EventContent): string {
  const canonical = canonicalize({
    id: content.id,
    type: content.type,
    origin: content.origin,
    payload: content.payload,
    decision: content.decision,
    at: content.at,
  });
  if (canonical === undefined) {
    throw new Error("event canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
