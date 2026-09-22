/**
 * @file src/operation-bundles/adapters/catalog.ts
 * @description The catalog store adapter — a thin call over the founding
 * append-only catalog store. Observation is by mutation identity (append-shaped);
 * apply constructs a closed record with the deterministic physical identity and
 * appends it through the whole-file-rewrite seam. Unavailable never falls through
 * to an append.
 */

import { appendCatalogRecordLocked, createCatalogRecord, findCatalogRecordByMutation, readCatalogStore } from "../catalog-store.js";
import type { CatalogRecordId } from "../ids.js";
import { defineOperationStoreAdapter, type AdapterContext, type OperationObservation, type OperationStoreAdapter } from "../adapter-types.js";
import type { CatalogOperationMutation } from "../types.js";
import { readBundlePayload } from "./shared.js";

/** Observe catalog state by the deterministic mutation identity. */
async function observeCatalog(ctx: AdapterContext<CatalogOperationMutation>): Promise<OperationObservation> {
  const read = await readCatalogStore(ctx.root, ctx.manifest.workspaceId);
  if (read.status === "unavailable" || read.status === "invalid") return { outcome: "unavailable", detail: "catalog is unreadable" };
  const records = read.status === "ok" ? read.records : [];
  const existing = findCatalogRecordByMutation(records, ctx.auditBinding.mutationId);
  // A catalog record is keyed by mutationId, so its presence proves this run produced it.
  return existing === undefined ? { outcome: "not-applied" } : { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true };
}

/** Classify a catalog append failure as unavailable (store fault) or conflict. */
function classifyAppendError(error: unknown): { status: "unavailable" | "conflict"; detail: string } {
  const message = error instanceof Error ? error.message : "catalog append failed";
  return { status: message.includes("unavailable") || message.includes("invalid") ? "unavailable" : "conflict", detail: message };
}

export const catalogAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"catalog-record">({
  kind: "catalog-record",

  async preflight(ctx) {
    const payload = await readBundlePayload(ctx.root, ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "catalog payload is unreadable" };
    try { JSON.parse(payload.bytes.toString("utf8")); }
    catch { return { status: "park", code: "bundle-precondition-conflict", detail: "catalog payload is not JSON" }; }
    return { status: "ready" };
  },

  observe: observeCatalog,

  async apply(ctx) {
    const payload = await readBundlePayload(ctx.root, ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "catalog payload is unreadable" };
    let record: ReturnType<typeof createCatalogRecord>;
    try {
      record = createCatalogRecord({
        logicalRecordId: ctx.mutation.target.logicalRecordId, mutationId: ctx.auditBinding.mutationId,
        payload: JSON.parse(payload.bytes.toString("utf8")), createdAt: ctx.manifest.createdAt,
        ...(ctx.mutation.target.supersedesRecordId === undefined ? {} : { supersedesRecordId: ctx.mutation.target.supersedesRecordId as CatalogRecordId }),
      });
    } catch (error) {
      return { status: "conflict", detail: error instanceof Error ? error.message : "catalog record is invalid" };
    }
    try {
      const result = await appendCatalogRecordLocked(ctx.root, ctx.manifest.workspaceId, record);
      return result === "same"
        ? { status: "skipped-idempotent", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true }
        : { status: "applied", postStateDigest: ctx.mutation.postcondition.digest };
    } catch (error) {
      return classifyAppendError(error);
    }
  },

  async verify(ctx) {
    const observation = await observeCatalog(ctx);
    if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
    if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "catalog unreadable" };
    return { status: "mismatch", detail: observation.detail ?? "catalog postcondition not met" };
  },
});
