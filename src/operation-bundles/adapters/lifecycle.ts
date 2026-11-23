/**
 * @file src/operation-bundles/adapters/lifecycle.ts
 * @description The lifecycle-transition store adapter. It observes the entity
 * page digest plus the bound lifecycle audit event, and applies through the
 * existing `applyLifecycleLocked` authority with the out-of-band binding threaded
 * so the child event is matched back to its mutation on crash replay.
 *
 * ONE BODY. {@link defineLifecycleAdapter} owns every verdict (the active
 * lifecycle, the page's pre/post/neither state, the bound event and its
 * duplicate and missing arms, the apply failure classes, verify) over
 * {@link LifecycleAdapterStores}, none of which takes a project root. The shipped
 * {@link lifecycleAdapter} passes the local stores, which read the context's root
 * when called: the profile loader, the confined entity-page digest (a disk
 * mechanism), the event reader and `applyLifecycleLocked`.
 * `AdapterContext.root` stays the compatibility handle a host adapter receives.
 */

import { indexedBoundEvents } from "../../history/bound-lookups.js";
import type { EventRecord } from "../../events/types.js";
import path from "node:path";
import { resolveConfinedEntityPage } from "../../profile/lifecycle-read.js";
import { readEvents, type ReadEventsResult } from "../../events/store-read.js";
import { applyLifecycleLocked, LifecycleTransitionUnavailableError } from "../../trust/lifecycle-apply.js";
import { LifecycleTransitionError } from "../../profile/lifecycle.js";
import type { LifecycleTransitionPlannedMutation } from "../../trust/planner.js";
import type { EntityTypeDef, ProfilePack } from "../../profile/types.js";
import type { OperationBinding } from "../../utils/operation-binding.js";
import {
  defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type AdapterPreflight, type AdapterVerify,
  type OperationObservation, type OperationStoreAdapter,
} from "../adapter-types.js";
import type { LifecycleOperationMutation, OperationDigest } from "../types.js";
import { applyResultFromObservation, confinedLeafDigest, loadProfileOrUndefined, toOperationBinding, type LeafDigest } from "./shared.js";

/**
 * Read and digest the confined entity page for one lifecycle target. Routes
 * through the same hardened confined reader the page adapter uses, so a
 * parent-dir swap after resolveConfinedEntityPage's realpath cannot slip a
 * different file's bytes past the digest.
 */
async function entityPageDigest(root: string, def: EntityTypeDef, slug: string): Promise<LeafDigest> {
  let real: string | null;
  try { real = await resolveConfinedEntityPage(root, def, slug); }
  catch { return { kind: "unavailable" }; }
  if (real === null) return { kind: "absent" };
  return confinedLeafDigest(root, real, path.join(root, def.directory));
}

/** What the lifecycle adapter asks of the project. No member takes a project root. */
export interface LifecycleAdapterStores {
  /** The active profile, or undefined when none is loadable. */
  loadProfile(): Promise<ProfilePack | undefined>;
  /** The confined entity page's digest for one target; never rejects (a resolver fault is `unavailable`). */
  readEntityPage(def: EntityTypeDef, slug: string): Promise<LeafDigest>;
  /** The project's audit events. */
  readEvents(): Promise<ReadEventsResult>;
  /** OPTIONAL: the events bound to one mutation via the `local-indexed` binding index, or `null` (then `readEvents` is used). */
  boundEvents?(mutationId: string): Promise<EventRecord[] | null>;
  /** Transition through the lifecycle authority with the out-of-band binding; the caller holds the project lock. */
  applyLifecycle(planned: LifecycleTransitionPlannedMutation, binding: OperationBinding): Promise<unknown>;
}

/** LOCAL DISK. The incumbent loader, confined page digest, event reader and lifecycle authority, each reading the context's root when called. */
function diskLifecycleAdapterStores(ctx: Pick<AdapterContext, "root">): LifecycleAdapterStores {
  return {
    loadProfile: () => loadProfileOrUndefined(ctx.root),
    readEntityPage: (def, slug) => entityPageDigest(ctx.root, def, slug),
    readEvents: () => readEvents(ctx.root),
    boundEvents: (mutationId) => indexedBoundEvents(ctx.root, mutationId),
    applyLifecycle: (planned, binding) => applyLifecycleLocked(ctx.root, planned, binding),
  };
}

/** Count bound lifecycle-transition events for this mutation. */
async function boundLifecycleEvents(stores: LifecycleAdapterStores, mutationId: string): Promise<number> {
  const events = (await stores.boundEvents?.(mutationId)) ?? (await stores.readEvents()).events;
  return events.filter((event) => event.type === "lifecycle-transition" && event.operationBinding?.mutationId === mutationId).length;
}

/** Classify a present entity page against the mutation's pre/post state + bound event. */
function classifyLifecyclePage(ctx: AdapterContext<LifecycleOperationMutation>, pageDigest: OperationDigest, bound: number): OperationObservation {
  if (pageDigest === ctx.mutation.postcondition.pageDigest) {
    // `applied` requires a bound lifecycle-transition event for THIS mutation.
    return bound === 1 ? { outcome: "applied", postStateDigest: pageDigest, boundToMutation: true } : { outcome: "partially-applied", auditRepairOnly: true, detail: "page transitioned, audit event missing" };
  }
  if (pageDigest === ctx.mutation.precondition.pageDigest) return { outcome: "not-applied" };
  return { outcome: "conflict", detail: "page digest matches neither lifecycle state" };
}

/** Observe lifecycle state by page digest plus the bound audit event. */
async function observeLifecycle(stores: LifecycleAdapterStores, ctx: AdapterContext<LifecycleOperationMutation>): Promise<OperationObservation> {
  const profile = await stores.loadProfile();
  const def = profile?.entities[ctx.mutation.target.entityType];
  if (!def?.lifecycle) return { outcome: "unavailable", detail: "entity type has no active lifecycle" };
  const page = await stores.readEntityPage(def, ctx.mutation.target.slug);
  if (page.kind === "unavailable") return { outcome: "unavailable", detail: "lifecycle page is unreadable" };
  if (page.kind === "absent") return { outcome: "conflict", detail: "lifecycle page is absent" };
  let bound: number;
  try { bound = await boundLifecycleEvents(stores, ctx.auditBinding.mutationId); }
  catch { return { outcome: "unavailable", detail: "event store is unreadable" }; }
  if (bound > 1) return { outcome: "conflict", detail: "duplicate lifecycle event for mutation" };
  return classifyLifecyclePage(ctx, page.digest, bound);
}

/** Map an applyLifecycleLocked failure to an apply result. */
function classifyLifecycleApplyError(error: unknown): AdapterApply {
  if (error instanceof LifecycleTransitionUnavailableError) return { status: "unavailable", detail: error.message };
  if (error instanceof LifecycleTransitionError) return { status: "conflict", detail: error.message };
  return { status: "unavailable", detail: error instanceof Error ? error.message : "lifecycle apply failed" };
}

/** Build the planned transition intent from the manifest mutation. */
function plannedTransition(mutation: LifecycleOperationMutation): LifecycleTransitionPlannedMutation {
  return {
    kind: "lifecycle-transition", entityType: mutation.target.entityType, slug: mutation.target.slug,
    toState: mutation.postcondition.state,
    ...(mutation.evidence === undefined ? {} : { evidence: mutation.evidence as Record<string, unknown> }),
  };
}

/** Preflight: the target's entity type must have an active lifecycle. */
async function preflightLifecycle(stores: LifecycleAdapterStores, ctx: AdapterContext<LifecycleOperationMutation>): Promise<AdapterPreflight> {
  const profile = await stores.loadProfile();
  const def = profile?.entities[ctx.mutation.target.entityType];
  if (!def?.lifecycle) return { status: "unavailable", detail: "entity type has no active lifecycle" };
  return { status: "ready" };
}

/** Apply: transition through the authority with the binding, then re-observe for the verdict. */
async function applyLifecycle(stores: LifecycleAdapterStores, ctx: AdapterContext<LifecycleOperationMutation>): Promise<AdapterApply> {
  try { await stores.applyLifecycle(plannedTransition(ctx.mutation), toOperationBinding(ctx.auditBinding)); }
  catch (error) { return classifyLifecycleApplyError(error); }
  return applyResultFromObservation(await observeLifecycle(stores, ctx), ctx.mutation.postcondition.pageDigest);
}

/** Verify: the observation, restated as a verdict. */
async function verifyLifecycle(stores: LifecycleAdapterStores, ctx: AdapterContext<LifecycleOperationMutation>): Promise<AdapterVerify> {
  const observation = await observeLifecycle(stores, ctx);
  if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.pageDigest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "lifecycle unreadable" };
  return { status: "mismatch", detail: observation.detail ?? "lifecycle postcondition not met" };
}

/** The lifecycle adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function defineLifecycleAdapter(storesOf: (ctx: AdapterContext<LifecycleOperationMutation>) => LifecycleAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"lifecycle-transition">({
    kind: "lifecycle-transition",
    preflight: (ctx) => preflightLifecycle(storesOf(ctx), ctx),
    observe: (ctx) => observeLifecycle(storesOf(ctx), ctx),
    apply: (ctx) => applyLifecycle(storesOf(ctx), ctx),
    verify: (ctx) => verifyLifecycle(storesOf(ctx), ctx),
  });
}

/** The shipped lifecycle adapter: the body over the local stores for each context's root. */
export const lifecycleAdapter: OperationStoreAdapter = defineLifecycleAdapter(diskLifecycleAdapterStores);
