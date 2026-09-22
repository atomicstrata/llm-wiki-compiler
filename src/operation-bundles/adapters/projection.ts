/**
 * @file src/operation-bundles/adapters/projection.ts
 * @description The projection store adapter. It renders deterministically and
 * network-free from the immutable recipe identity, writes output plus its
 * format-neutral sidecar through the founding projection store, and never lets an
 * authoritative mutation depend on it (the executor runs projections last). The
 * required/optional criticality is manifest data and cannot be changed by the
 * renderer.
 */

import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { observeProjection, writeProjectionLocked, type ProjectionTarget } from "../projection-store.js";
import { defineOperationStoreAdapter, type AdapterContext, type OperationObservation, type OperationStoreAdapter } from "../adapter-types.js";
import type { ProjectionCriticality } from "../run-types.js";
import type { ProjectionOperationMutation } from "../types.js";
import { digestBytes } from "./shared.js";

/**
 * The Milestone A deterministic, network-free render: a canonical descriptor of
 * the immutable recipe identity and output path. A host recipe engine that folds
 * committed authoritative reads is later scope; this render never reaches the
 * network and depends on no projection.
 */
function renderProjection(mutation: ProjectionOperationMutation): Buffer {
  return canonicalBytes({
    recipeId: mutation.target.recipeId,
    recipeDigest: mutation.target.recipeDigest,
    output: mutation.target.output,
  });
}

/** The manifest-declared criticality; the renderer cannot change it. */
export function projectionCriticality(mutation: ProjectionOperationMutation): ProjectionCriticality {
  return mutation.target.criticality;
}

/** Build the store target from the manifest mutation and its postcondition. */
function projectionTarget(ctx: AdapterContext<ProjectionOperationMutation>): ProjectionTarget {
  return {
    workspaceId: ctx.manifest.workspaceId, recipeId: ctx.mutation.target.recipeId,
    recipeDigest: ctx.mutation.target.recipeDigest, output: ctx.mutation.target.output,
    outputDigest: ctx.mutation.postcondition.digest, criticality: ctx.mutation.target.criticality,
  };
}

/** Observe projection state through the founding store's exact classification. */
async function observeProjectionState(ctx: AdapterContext<ProjectionOperationMutation>): Promise<OperationObservation> {
  const observation = await observeProjection(ctx.root, projectionTarget(ctx));
  switch (observation.status) {
    case "absent": return { outcome: "not-applied" };
    // Projections are recipe-addressed with no per-mutation binding (unbound).
    case "same": return { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: false };
    case "replaceable": return { outcome: "not-applied" };
    case "conflict": return { outcome: "conflict", detail: observation.detail };
    default: return { outcome: "unavailable", detail: observation.detail };
  }
}

export const projectionAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"projection">({
  kind: "projection",

  async preflight(ctx) {
    if (digestBytes(renderProjection(ctx.mutation)) !== ctx.mutation.postcondition.digest) {
      return { status: "park", code: "bundle-precondition-conflict", detail: "projection render digest mismatch" };
    }
    return { status: "ready" };
  },

  observe: observeProjectionState,

  async apply(ctx) {
    const bytes = renderProjection(ctx.mutation);
    if (digestBytes(bytes) !== ctx.mutation.postcondition.digest) {
      return { status: "conflict", detail: "projection render digest mismatch" };
    }
    try {
      const result = await writeProjectionLocked(ctx.root, projectionTarget(ctx), bytes);
      return result === "same"
        ? { status: "skipped-idempotent", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: false }
        : { status: "applied", postStateDigest: ctx.mutation.postcondition.digest };
    } catch (error) {
      const message = error instanceof Error ? error.message : "projection write failed";
      return { status: message.includes("unavailable") ? "unavailable" : "conflict", detail: message };
    }
  },

  async verify(ctx) {
    const observation = await observeProjectionState(ctx);
    if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
    if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "projection unreadable" };
    return { status: "mismatch", detail: observation.detail ?? "projection postcondition not met" };
  },
});
