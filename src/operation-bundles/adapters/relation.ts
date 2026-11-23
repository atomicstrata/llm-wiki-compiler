/**
 * @file src/operation-bundles/adapters/relation.ts
 * @description The relation store adapter. It observes append-shaped state by the
 * deterministic mutation identity plus relation content, and applies through the
 * operation-aware relation seam (never a duplicate write to attach a mutation id).
 * An authority record present without its child audit event is partially applied;
 * recovery repairs only the event.
 *
 * ONE BODY. {@link defineRelationAdapter} owns every verdict (profile validity,
 * the declared-digest and promise checks, the append-shaped observation with
 * its duplicate, partial and unbound-satisfaction arms, the operation-aware
 * append's outcomes, verify) over {@link RelationAdapterStores}, none of which
 * takes a project root. The shipped {@link relationAdapter} passes the local
 * stores, which read the context's root when called and call the incumbent
 * profile loader, relation and event readers and
 * `appendRelationForOperationLocked`. `AdapterContext.root` stays the
 * compatibility handle a host adapter receives.
 */

import { indexedRelationState, type IndexedRelationState } from "../../history/bound-lookups.js";
import { readEvents, type ReadEventsResult } from "../../events/store-read.js";
import { appendRelationForOperationLocked, type RelationOperationApply } from "../../relations/operation-write.js";
import { relationContentHash } from "../../relations/digest.js";
import { buildRelationRef, type AppendRelationInput } from "../../relations/store.js";
import { readRelationRecords, type BoundRelationRecord, type ReadRelationRecordsResult } from "../../relations/store-read.js";
import type { CitationRef, RelationRef } from "../../relations/types.js";
import type { EntityId, ProfilePack } from "../../profile/types.js";
import type { OperationBinding } from "../../utils/operation-binding.js";
import {
  defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type AdapterPreflight, type AdapterVerify,
  type OperationObservation, type OperationStoreAdapter,
} from "../adapter-types.js";
import type { RelationOperationMutation } from "../types.js";
import { loadProfileOrUndefined, toOperationBinding } from "./shared.js";

/** What the relation adapter asks of the project. No member takes a project root. */
export interface RelationAdapterStores {
  /** The active profile, or undefined when none is loadable. */
  loadProfile(): Promise<ProfilePack | undefined>;
  /** Every relation record with its operation binding. */
  readRelations(): Promise<ReadRelationRecordsResult>;
  /** The project's audit events. */
  readEvents(): Promise<ReadEventsResult>;
  /** OPTIONAL: the mutation's relation state through `local-indexed` point lookups, or `null` (then the whole reads are used). */
  indexedState?(mutationId: string): Promise<IndexedRelationState | null>;
  /** The operation-aware append (never a duplicate write); the caller holds the project lock. */
  appendForOperation(profile: ProfilePack, input: AppendRelationInput, binding: OperationBinding, promisedId: RelationRef["id"]): Promise<RelationOperationApply>;
}

/** LOCAL DISK. The incumbent loader, readers and relation seam, each reading the context's root when called. */
function diskRelationAdapterStores(ctx: Pick<AdapterContext, "root">): RelationAdapterStores {
  return {
    loadProfile: () => loadProfileOrUndefined(ctx.root),
    readRelations: () => readRelationRecords(ctx.root),
    readEvents: () => readEvents(ctx.root),
    indexedState: (mutationId) => indexedRelationState(ctx.root, mutationId),
    appendForOperation: (profile, input, binding, promisedId) => appendRelationForOperationLocked(ctx.root, profile, input, binding, promisedId),
  };
}

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

/** The content hash the mutation declares under the active profile, or the observation that stops the check. */
async function declaredContentHash(stores: RelationAdapterStores, mutation: RelationOperationMutation): Promise<string | OperationObservation> {
  const digestConflict = declaredDigestConflict(mutation);
  if (digestConflict !== null) return { outcome: "conflict", detail: digestConflict };
  const profile = await stores.loadProfile();
  if (!profile) return { outcome: "unavailable", detail: "no profile is active" };
  try { return buildRelationRef(profile, relationInput(mutation)).contentHash; }
  catch { return { outcome: "conflict", detail: "relation content is invalid for the active profile" }; }
}

/** Observe append-shaped relation state against the mutation identity + content. */
async function observeRelation(stores: RelationAdapterStores, ctx: AdapterContext<RelationOperationMutation>): Promise<OperationObservation> {
  const mutationId = ctx.auditBinding.mutationId;
  const state = await relationState(stores, mutationId);
  if (state === null) return { outcome: "unavailable", detail: "relation or event store is unreadable" };
  const boundRecords = state.records.filter((record) => record.operationBinding?.mutationId === mutationId);
  if (boundRecords.length > 1 || state.boundEvents > 1) return { outcome: "conflict", detail: "duplicate relation authority for mutation" };
  const contentHash = await declaredContentHash(stores, ctx.mutation);
  if (typeof contentHash !== "string") return contentHash;
  const live = state.live === undefined ? liveContentRef(state.records, contentHash) : await state.live(contentHash);
  if (boundRecords.length === 0 && live === undefined) return { outcome: "not-applied" };
  return presenceOutcome(ctx.mutation, boundRecords.length, state.boundEvents, live);
}

/** Read the relation and event stores for one mutation identity, or null when unreadable. */
async function relationState(
  stores: RelationAdapterStores, mutationId: string,
): Promise<{ records: readonly BoundRelationRecord[]; boundEvents: number; live?: IndexedRelationState["live"] } | null> {
  try {
    const indexed = await stores.indexedState?.(mutationId);
    if (indexed) return { records: indexed.bound, boundEvents: indexed.boundEvents, live: indexed.live };
    const records = (await stores.readRelations()).records;
    const boundEvents = (await stores.readEvents()).events
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

/** Preflight: an active profile under which the relation content is valid. */
async function preflightRelation(stores: RelationAdapterStores, ctx: AdapterContext<RelationOperationMutation>): Promise<AdapterPreflight> {
  const profile = await stores.loadProfile();
  if (!profile) return { status: "unavailable", detail: "no profile is active" };
  try { buildRelationRef(profile, relationInput(ctx.mutation)); }
  catch (error) { return { status: "park", code: "bundle-precondition-conflict", detail: error instanceof Error ? error.message : "invalid relation" }; }
  return { status: "ready" };
}

/** Apply: refuse a dishonest promise, then append through the operation-aware seam and name any dedupe. */
async function applyRelation(stores: RelationAdapterStores, ctx: AdapterContext<RelationOperationMutation>): Promise<AdapterApply> {
  const profile = await stores.loadProfile();
  if (!profile) return { status: "unavailable", detail: "no profile is active" };
  const refused = promiseConflict(profile, ctx.mutation);
  if (refused !== null) return { status: "conflict", detail: refused };
  let result: RelationOperationApply;
  try {
    result = await stores.appendForOperation(
      profile, relationInput(ctx.mutation), toOperationBinding(ctx.auditBinding),
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
}

/** Verify: the observation, restated as a verdict. */
async function verifyRelation(stores: RelationAdapterStores, ctx: AdapterContext<RelationOperationMutation>): Promise<AdapterVerify> {
  const observation = await observeRelation(stores, ctx);
  if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "relation unreadable" };
  return { status: "mismatch", detail: observation.detail ?? "relation postcondition not met" };
}

/** The relation adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function defineRelationAdapter(storesOf: (ctx: AdapterContext<RelationOperationMutation>) => RelationAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"relation">({
    kind: "relation",
    preflight: (ctx) => preflightRelation(storesOf(ctx), ctx),
    observe: (ctx) => observeRelation(storesOf(ctx), ctx),
    apply: (ctx) => applyRelation(storesOf(ctx), ctx),
    verify: (ctx) => verifyRelation(storesOf(ctx), ctx),
  });
}

/** The shipped relation adapter: the body over the local stores for each context's root. */
export const relationAdapter: OperationStoreAdapter = defineRelationAdapter(diskRelationAdapterStores);
