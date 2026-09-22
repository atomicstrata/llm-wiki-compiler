/**
 * @file src/operation-bundles/adapters/relation.ts
 * @description The relation store adapter. It observes append-shaped state by the
 * deterministic mutation identity plus relation content, and applies through the
 * operation-aware relation seam (never a duplicate write to attach a mutation id).
 * An authority record present without its child audit event is partially applied;
 * recovery repairs only the event.
 */

import { readEvents } from "../../events/store-read.js";
import { appendRelationForOperationLocked } from "../../relations/operation-write.js";
import { relationContentHash } from "../../relations/digest.js";
import { buildRelationRef, type AppendRelationInput } from "../../relations/store.js";
import { readRelationRecords, type BoundRelationRecord } from "../../relations/store-read.js";
import type { CitationRef } from "../../relations/types.js";
import type { EntityId, ProfilePack } from "../../profile/types.js";
import { defineOperationStoreAdapter, type AdapterContext, type OperationObservation, type OperationStoreAdapter } from "../adapter-types.js";
import type { RelationOperationMutation } from "../types.js";
import { loadProfileOrUndefined, toOperationBinding } from "./shared.js";

/** Build the validated relation input from the manifest mutation. */
function relationInput(mutation: RelationOperationMutation): AppendRelationInput {
  return {
    type: mutation.target.relationType,
    from: mutation.target.from as EntityId,
    to: mutation.target.to as EntityId,
    attributes: mutation.attributes as Record<string, unknown>,
    ...(mutation.evidence === undefined ? {} : { evidence: mutation.evidence as CitationRef[] }),
  };
}

/** The latest live relation matching this content (dedup by content hash), if any. */
function liveContentRef(records: readonly BoundRelationRecord[], contentHash: string): BoundRelationRecord | undefined {
  const byId = new Map<string, BoundRelationRecord>();
  for (const record of records) byId.set(record.ref.id, record);
  return [...byId.values()].find((record) => record.ref.contentHash === contentHash);
}

/**
 * The ONE declared-digest predicate every vouching leg runs: the attested
 * postcondition digest must be the store's `relationContentHash` over the
 * mutation's OWN declared content. Apply refuses on it, and observe/verify run
 * it too — a bound child event proves the content landed, but it cannot make a
 * digest that never bound the declared bytes true, so an observation must not
 * report applied-clean over a false attestation.
 */
function declaredDigestConflict(mutation: RelationOperationMutation): string | null {
  const declared = relationContentHash({
    type: mutation.target.relationType, from: mutation.target.from as EntityId,
    to: mutation.target.to as EntityId, attributes: mutation.attributes as Record<string, unknown>,
    evidence: mutation.evidence as CitationRef[] | undefined,
  });
  return mutation.postcondition.digest === `sha256:${declared}`
    ? null : "relation postcondition digest is not the declared content hash";
}

/** Observe append-shaped relation state against the mutation identity + content. */
async function observeRelation(ctx: AdapterContext<RelationOperationMutation>): Promise<OperationObservation> {
  const mutationId = ctx.auditBinding.mutationId;
  const state = await relationState(ctx.root, mutationId);
  if (state === null) return { outcome: "unavailable", detail: "relation or event store is unreadable" };
  const boundRecords = state.records.filter((record) => record.operationBinding?.mutationId === mutationId);
  if (boundRecords.length > 1 || state.boundEvents > 1) return { outcome: "conflict", detail: "duplicate relation authority for mutation" };
  const digestConflict = declaredDigestConflict(ctx.mutation);
  if (digestConflict !== null) return { outcome: "conflict", detail: digestConflict };
  const profile = await loadProfileOrUndefined(ctx.root);
  if (!profile) return { outcome: "unavailable", detail: "no profile is active" };
  let contentHash: string;
  try { contentHash = buildRelationRef(profile, relationInput(ctx.mutation)).contentHash; }
  catch { return { outcome: "conflict", detail: "relation content is invalid for the active profile" }; }
  const live = liveContentRef(state.records, contentHash);
  if (boundRecords.length === 0 && live === undefined) return { outcome: "not-applied" };
  return presenceOutcome(ctx.mutation, boundRecords.length, state.boundEvents, live);
}

/** Read the relation and event stores for one mutation identity, or null when unreadable. */
async function relationState(
  root: string, mutationId: string,
): Promise<{ records: readonly BoundRelationRecord[]; boundEvents: number } | null> {
  try {
    const records = (await readRelationRecords(root)).records;
    const boundEvents = (await readEvents(root)).events
      .filter((event) => event.operationBinding?.mutationId === mutationId).length;
    return { records, boundEvents };
  } catch {
    return null;
  }
}

/**
 * Classify a PRESENT effect. `applied` requires a bound child event for THIS
 * mutation, so the present effect is this run's (a pre-existing/unbound relation
 * has no bound event -> partial). An UNBOUND satisfaction names the record that
 * satisfies the content, so a recovery-derived skip keeps the forward path's
 * observable claim boundary.
 */
function presenceOutcome(
  mutation: RelationOperationMutation, boundCount: number, boundEvents: number,
  live: BoundRelationRecord | undefined,
): OperationObservation {
  if (boundEvents !== 1) return { outcome: "partially-applied", auditRepairOnly: true, detail: "relation present, child audit event missing" };
  const bound = boundCount === 1;
  return {
    outcome: "applied", postStateDigest: mutation.postcondition.digest, boundToMutation: bound,
    ...(bound || live === undefined ? {} : { detail: `content satisfied by existing relation ${live.ref.id}` }),
  };
}

/**
 * The conflict that refuses a postcondition promise the store could never make
 * true, or null when the promise is honest. EACH POSTCONDITION HALF BINDS A
 * NAMED QUANTITY: `recordId` binds the record this mutation CREATES (and must
 * be `rel_`-form — the store's reader requires it); `digest` binds the DECLARED
 * canonical payload — the manifest's own bytes, hashed with the store's
 * `relationContentHash` over endpoints AS DECLARED. Either endpoint order is a
 * valid declaration for a symmetric type: the store's own canonicalization
 * supplies the deterministic declared→persisted relationship, and observe,
 * verify, and the apply seam's own lookup all check store presence by that
 * CANONICAL hash — so the relationship is verified where the store enforces it.
 * Requiring canonical equality HERE was a retry trap: a valid symmetric
 * declaration in the other order deterministically re-attested the same
 * declared hash on every retry and could never apply.
 */
function promiseConflict(profile: ProfilePack, mutation: RelationOperationMutation): string | null {
  if (!mutation.postcondition.recordId.startsWith("rel_")) {
    return "relation postcondition recordId is not a relation id";
  }
  try { buildRelationRef(profile, relationInput(mutation)); }
  catch (error) { return error instanceof Error ? error.message : "invalid relation"; }
  return declaredDigestConflict(mutation);
}

export const relationAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"relation">({
  kind: "relation",

  async preflight(ctx) {
    const profile = await loadProfileOrUndefined(ctx.root);
    if (!profile) return { status: "unavailable", detail: "no profile is active" };
    try { buildRelationRef(profile, relationInput(ctx.mutation)); }
    catch (error) { return { status: "park", code: "bundle-precondition-conflict", detail: error instanceof Error ? error.message : "invalid relation" }; }
    return { status: "ready" };
  },

  observe: observeRelation,

  async apply(ctx) {
    const profile = await loadProfileOrUndefined(ctx.root);
    if (!profile) return { status: "unavailable", detail: "no profile is active" };
    const refused = promiseConflict(profile, ctx.mutation);
    if (refused !== null) return { status: "conflict", detail: refused };
    let result: Awaited<ReturnType<typeof appendRelationForOperationLocked>>;
    try {
      result = await appendRelationForOperationLocked(
        ctx.root, profile, relationInput(ctx.mutation), toOperationBinding(ctx.auditBinding),
        ctx.mutation.postcondition.recordId as `rel_${string}`,
      );
    } catch (error) {
      return { status: "unavailable", detail: error instanceof Error ? error.message : "relation apply failed" };
    }
    if (result.status === "conflict") return { status: "conflict", detail: result.detail };
    if (result.status === "skipped-idempotent") {
      // The postcondition's recordId binds only records this mutation CREATES; a
      // dedupe kept a pre-existing record, so the skip NAMES the id that actually
      // satisfies the content — the claim boundary is observable, never silent.
      return {
        status: "skipped-idempotent", postStateDigest: ctx.mutation.postcondition.digest,
        boundToMutation: result.bound, detail: `content satisfied by existing relation ${result.ref.id}`,
      };
    }
    return { status: "applied", postStateDigest: ctx.mutation.postcondition.digest };
  },

  async verify(ctx) {
    const observation = await observeRelation(ctx);
    if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
    if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "relation unreadable" };
    return { status: "mismatch", detail: observation.detail ?? "relation postcondition not met" };
  },
});
