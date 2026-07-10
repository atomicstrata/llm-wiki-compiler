/**
 * @file src/relations/live-valid.ts
 * @description The shared "live, profile-valid relations" reader: the LATEST
 * record per id (via the lock-free {@link readRelations}) filtered to those that
 * still satisfy the CURRENT profile (via {@link validateRelationAgainstProfile}).
 *
 * This is the ONE place the two concerns compose. The read surfaces that want the
 * live relations a project can actually USE — the JSON export's relation views and
 * the viewer snapshot's typed graph edges — route through this instead of
 * re-inlining `readRelations(...).filter(validate... === 0)`, so they cannot drift
 * on what "usable" means and a future consumer inherits the same semantics.
 *
 * LOCK-FREE INVARIANT: this reads via {@link readRelations} (the lock-free store
 * read) and acquires NOTHING — no project lock, no `underLock`-wrapped API. That
 * is deliberate and load-bearing: a caller that ALREADY holds the project lock
 * (e.g. a locked read-modify-append) can call this without a self-acquire that
 * would release the held lock early or deadlock. Never add locking here.
 *
 * NOT for sites that need more than the valid list. Callers that also need the
 * FULL live set (relation compaction, whose audit event enumerates the dropped
 * records in on-disk order), the INVALID count (the status/profile summary tally),
 * or each relation's per-reason validity (relation lint's findings + dangling
 * checks) read {@link readRelations} directly — this reader intentionally hides
 * the invalid records, so forcing those sites through it would change behavior.
 */

import type { ProfilePack } from "../profile/types.js";
import type { RelationRef } from "./types.js";
import { readRelations } from "./store-read.js";
import { validateRelationAgainstProfile } from "./relation-contract.js";

/**
 * Read the live relations (latest record per id) that are STILL VALID against the
 * given profile — its type still declared, endpoints still within the declared
 * `from`/`to` sets, attributes/evidence still satisfying the contract. Relations
 * the profile has outgrown are OMITTED (retained on disk, never counted as live).
 *
 * Propagates the same fail-closed read errors {@link readRelations} throws (a
 * corrupt / too-new / symlinked-leaf store, or a symlinked/escaping `wiki/graph`
 * dir); callers that must fail closed VISIBLY wrap the throw into their own
 * problem shape. Lock-free — see the file overview's LOCK-FREE INVARIANT.
 *
 * @param root - Absolute project root.
 * @param profile - The current governing profile pack each stored relation is
 *   re-validated against.
 * @returns The live, profile-valid relations in first-seen id order.
 */
export async function readLiveValidRelations(root: string, profile: ProfilePack): Promise<RelationRef[]> {
  const { relations } = await readRelations(root);
  return relations.filter((rel) => validateRelationAgainstProfile(rel, profile).length === 0);
}
