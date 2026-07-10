/**
 * @file The bundle-RELATION leg of OKF import (CLP 7.6 Task 5, D-7.6.6).
 *
 * Task 3 parses the bundle-level `x-llmwiki.relations` list into untrusted,
 * leaf-type-checked {@link BundleRelationEntry} records. This module APPLIES them
 * to the local relation store — TRUSTED MODE ONLY. v0 has no staged-relation
 * review path, so an UNTRUSTED import must never write a relation (every entry is
 * reported `skipped-untrusted`); only `--trusted` promotes them through the
 * validated write seam.
 *
 * Each trusted entry is built into an {@link AppendRelationInput} carrying ONLY
 * `type`/`from`/`to`/`attributes`. The foreign `id` and `contentHash` are NEVER
 * trusted — the store mints its own id and recomputes its own content hash (they
 * are reporting-only on the parsed entry); no `evidence` is carried in v0. The
 * entry endpoints stay verbatim strings: the store's OWN validation (canonical
 * endpoint entity-type scope + slug-safe {@link EntityId} grammar + attribute
 * contract) is the trust boundary, so a bad endpoint is REFUSED, never
 * pre-normalized into acceptance.
 *
 * Outcomes per entry: a fresh append is `imported`; a content-hash dedup hit
 * (the store returns the EXISTING record — detected because its id was already
 * live) is `deduplicated`; a {@link RelationEndpointError} (unknown type,
 * endpoint-scope refusal, or attribute-contract failure) is `skipped-invalid`
 * with the reason. A store-full / corrupt error FAILS CLOSED: the remaining
 * entries are aborted and reported `skipped-store-error`, but the page import
 * (already landed) is NOT failed — the report carries the truncation honestly.
 *
 * The caller MUST already hold the project lock: this routes through the
 * lock-free {@link appendRelationLocked} (a self-locking append would deadlock
 * under the held import lock, mirroring the typed-doc leg).
 */

import { appendRelationLocked, type AppendRelationInput } from "../relations/store.js";
import { readRelations } from "../relations/store-read.js";
import { RelationEndpointError, type RelationId } from "../relations/types.js";
import type { EntityId, ProfilePack } from "../profile/types.js";
import type { BundleRelationEntry } from "../export/okf/bundle-block.js";

/** How a single bundle relation resolved against the local relation store. */
export type RelationImportResult =
  | "imported"
  | "deduplicated"
  | "skipped-invalid"
  | "skipped-untrusted"
  | "skipped-no-profile"
  | "skipped-dry-run"
  | "skipped-store-error";

/** One entry's import outcome, surfaced in the import report's `relationOutcomes`. */
export interface RelationImportOutcome {
  type: string;
  from: string;
  to: string;
  outcome: RelationImportResult;
  /** Detail for a `skipped-invalid` refusal or a `skipped-store-error` abort. */
  reason?: string;
}

/** Shape one entry's outcome, attaching `reason` only when present. */
function outcomeFor(entry: BundleRelationEntry, outcome: RelationImportResult, reason?: string): RelationImportOutcome {
  return { type: entry.type, from: entry.from, to: entry.to, outcome, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * Map every entry to the same inert outcome (no store touch). Used for the
 * untrusted, default-project (no profile), and dry-run legs — none of which may
 * write a relation.
 */
export function inertRelationOutcomes(
  entries: BundleRelationEntry[],
  outcome: "skipped-untrusted" | "skipped-no-profile" | "skipped-dry-run",
): RelationImportOutcome[] {
  return entries.map((entry) => outcomeFor(entry, outcome));
}

/**
 * Build the trusted write input from an untrusted entry: name each field
 * explicitly so the foreign `id`/`contentHash` can NEVER ride in. Endpoints pass
 * through verbatim (cast to {@link EntityId}) so the store's slug-safe + scope
 * validation is the sole boundary; no `evidence` in v0.
 */
function toAppendInput(entry: BundleRelationEntry): AppendRelationInput {
  return {
    type: entry.type,
    from: entry.from as EntityId,
    to: entry.to as EntityId,
    attributes: entry.attributes ?? {},
  };
}

/**
 * Apply one relation through {@link appendRelationLocked}. A returned id already
 * present in `known` means the store deduped to an existing record
 * (`deduplicated`); otherwise it is a fresh `imported` append (recorded in `known`
 * so a later identical entry in the same batch dedups too). A
 * {@link RelationEndpointError} is caught as `skipped-invalid`; any other (store)
 * error is rethrown for the caller to abort the remaining entries.
 */
async function applyOneRelation(
  root: string,
  profile: ProfilePack,
  entry: BundleRelationEntry,
  known: Set<RelationId>,
): Promise<RelationImportOutcome> {
  try {
    const ref = await appendRelationLocked(root, profile, toAppendInput(entry));
    const deduped = known.has(ref.id);
    known.add(ref.id);
    return outcomeFor(entry, deduped ? "deduplicated" : "imported");
  } catch (error) {
    if (error instanceof RelationEndpointError) return outcomeFor(entry, "skipped-invalid", error.message);
    throw error;
  }
}

/** Report the failing + remaining entries as `skipped-store-error` (fail closed, page import preserved). */
function abortRemaining(entries: BundleRelationEntry[], error: unknown): RelationImportOutcome[] {
  const reason = `relation store unavailable: ${(error as Error).message}`;
  return entries.map((entry) => outcomeFor(entry, "skipped-store-error", reason));
}

/**
 * Apply every entry in order through the validated store, seeding the known-id
 * set from the current live relations so a content-hash dedup is recognized. A
 * store-full / corrupt fault (on the initial read or any append) fails CLOSED:
 * the failing + remaining entries become `skipped-store-error` and the loop
 * stops, but nothing throws — the page import stays intact.
 */
async function applyTrustedRelations(
  root: string,
  profile: ProfilePack,
  entries: BundleRelationEntry[],
): Promise<RelationImportOutcome[]> {
  let known: Set<RelationId>;
  try {
    known = new Set((await readRelations(root)).relations.map((rel) => rel.id));
  } catch (error) {
    return abortRemaining(entries, error);
  }
  const outcomes: RelationImportOutcome[] = [];
  for (let i = 0; i < entries.length; i++) {
    try {
      outcomes.push(await applyOneRelation(root, profile, entries[i], known));
    } catch (error) {
      return [...outcomes, ...abortRemaining(entries.slice(i), error)];
    }
  }
  return outcomes;
}

/**
 * Apply the parsed bundle relations to the local relation store, returning one
 * outcome per entry. UNTRUSTED (`trusted === false`) writes nothing — every entry
 * is `skipped-untrusted` (D-7.6.6, no staged-relation path in v0). TRUSTED routes
 * each entry through the validated store under the caller's held lock.
 *
 * @param root - Absolute project root directory.
 * @param profile - The active non-default profile pack (the relation schema).
 * @param entries - The untrusted, parsed bundle relations.
 * @param trusted - Whether to apply the relations (else report them skipped-untrusted).
 * @returns One {@link RelationImportOutcome} per entry.
 */
export async function applyBundleRelations(
  root: string,
  profile: ProfilePack,
  entries: BundleRelationEntry[],
  trusted: boolean,
): Promise<RelationImportOutcome[]> {
  if (!trusted) return inertRelationOutcomes(entries, "skipped-untrusted");
  return applyTrustedRelations(root, profile, entries);
}
