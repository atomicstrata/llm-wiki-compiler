/**
 * @file src/connectors/candidate-identity.ts
 * @description Immutable host-owned connector candidate identity. The
 * compiled-in canonical-source function runs exactly once, then its exact
 * source string, digest key, and validated host slug travel together through
 * preflight, fetch composition, locked selection, staging, audit, and result
 * assembly. Invalid runtime output is reduced to one fixed refusal upstream.
 */

import { assertCandidateSlug } from "../compiler/candidate-paths.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";
import { sha256Text } from "./hash.js";
import type { ConnectorDef } from "./types.js";

const PREFLIGHT_CANDIDATE_SUFFIX = "f".repeat(64);
const STAGED_CANDIDATE_SUFFIX = "f".repeat(8);
const MAX_CANONICAL_SOURCE_UNITS = 512;
const MAX_CANONICAL_SOURCE_BYTES = 512;

/** Fixed normal-run refusal for an invalid host-owned candidate identity. */
export const INVALID_CONNECTOR_IDENTITY = "connector candidate identity is invalid";

/** Immutable identity captured once before candidate or external side effects. */
export interface ConnectorCandidateIdentity {
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly canonicalSourceId: string;
  readonly idempotencyKey: string;
  readonly slug: string;
}

/** Host-computed stable idempotency key from connector and canonical source. */
function idempotencyKey(connectorId: string, canonicalSourceId: string): string {
  return sha256Text(`${connectorId}\n${canonicalSourceId}`);
}

/** Host-computed slug, never response-derived. */
function hostSlug(connectorId: string, canonicalSourceId: string): string {
  const suffix = canonicalSourceId.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return `${connectorId}-${suffix || "source"}`;
}

/** Derive and validate the one immutable candidate identity for this run. */
export function captureConnectorIdentity(
  def: Pick<ConnectorDef, "id" | "version" | "canonicalSourceId">,
  inputs: Record<string, string>,
): ConnectorCandidateIdentity | null {
  try {
    const canonicalSourceId = def.canonicalSourceId(inputs) as unknown;
    if (typeof canonicalSourceId !== "string") return null;
    if (canonicalSourceId.length > MAX_CANONICAL_SOURCE_UNITS) return null;
    if (!isWellFormedUnicode(canonicalSourceId)) return null;
    if (Buffer.byteLength(canonicalSourceId, "utf8") > MAX_CANONICAL_SOURCE_BYTES) return null;
    const slug = hostSlug(def.id, canonicalSourceId);
    assertCandidateSlug(slug);
    return Object.freeze({
      connectorId: def.id,
      connectorVersion: def.version,
      canonicalSourceId,
      idempotencyKey: idempotencyKey(def.id, canonicalSourceId),
      slug,
    });
  } catch {
    return null;
  }
}

/** Conservative over-length ID used only for the pre-fetch event-byte bound. */
export function preflightCandidateId(slug: string): string {
  return `${slug}-${PREFLIGHT_CANDIDATE_SUFFIX}`;
}

/** Exact-length stand-in used by the locked pre-stage event-byte check. */
export function stagedCandidatePreflightId(slug: string): string {
  return `${slug}-${STAGED_CANDIDATE_SUFFIX}`;
}
