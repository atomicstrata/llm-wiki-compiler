/**
 * @file src/operation-bundles/adapters/lifecycle.ts
 * @description The lifecycle-transition store adapter. It observes the entity
 * page digest plus the bound lifecycle audit event, and applies through the
 * existing `applyLifecycleLocked` authority with the out-of-band binding threaded
 * so the child event is matched back to its mutation on crash replay.
 */

import path from "node:path";
import { resolveConfinedEntityPage } from "../../profile/lifecycle-read.js";
import { readEvents } from "../../events/store-read.js";
import { applyLifecycleLocked, LifecycleTransitionUnavailableError } from "../../trust/lifecycle-apply.js";
import { LifecycleTransitionError } from "../../profile/lifecycle.js";
import type { LifecycleTransitionPlannedMutation } from "../../trust/planner.js";
import type { EntityTypeDef } from "../../profile/types.js";
import { defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type OperationObservation, type OperationStoreAdapter } from "../adapter-types.js";
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

/** Count bound lifecycle-transition events for this mutation. */
async function boundLifecycleEvents(root: string, mutationId: string): Promise<number> {
  const { events } = await readEvents(root);
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
async function observeLifecycle(ctx: AdapterContext<LifecycleOperationMutation>): Promise<OperationObservation> {
  const profile = await loadProfileOrUndefined(ctx.root);
  const def = profile?.entities[ctx.mutation.target.entityType];
  if (!def?.lifecycle) return { outcome: "unavailable", detail: "entity type has no active lifecycle" };
  const page = await entityPageDigest(ctx.root, def, ctx.mutation.target.slug);
  if (page.kind === "unavailable") return { outcome: "unavailable", detail: "lifecycle page is unreadable" };
  if (page.kind === "absent") return { outcome: "conflict", detail: "lifecycle page is absent" };
  let bound: number;
  try { bound = await boundLifecycleEvents(ctx.root, ctx.auditBinding.mutationId); }
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

export const lifecycleAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"lifecycle-transition">({
  kind: "lifecycle-transition",

  async preflight(ctx) {
    const profile = await loadProfileOrUndefined(ctx.root);
    const def = profile?.entities[ctx.mutation.target.entityType];
    if (!def?.lifecycle) return { status: "unavailable", detail: "entity type has no active lifecycle" };
    return { status: "ready" };
  },

  observe: observeLifecycle,

  async apply(ctx) {
    try { await applyLifecycleLocked(ctx.root, plannedTransition(ctx.mutation), toOperationBinding(ctx.auditBinding)); }
    catch (error) { return classifyLifecycleApplyError(error); }
    return applyResultFromObservation(await observeLifecycle(ctx), ctx.mutation.postcondition.pageDigest);
  },

  async verify(ctx) {
    const observation = await observeLifecycle(ctx);
    if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.pageDigest };
    if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "lifecycle unreadable" };
    return { status: "mismatch", detail: observation.detail ?? "lifecycle postcondition not met" };
  },
});
