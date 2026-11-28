/**
 * @file src/operation-bundles/adapters/catalog.ts
 * @description The catalog store adapter — a thin call over the founding
 * append-only catalog store. Observation is by mutation identity (append-shaped);
 * apply constructs a closed record with the deterministic physical identity and
 * appends it through the whole-file-rewrite seam. Unavailable never falls through
 * to an append.
 *
 * ONE BODY. {@link defineCatalogAdapter} owns every verdict (the payload gate,
 * the observation by mutation identity, the closed record and the append's
 * failure classes, verify) over {@link CatalogAdapterStores}, none of which takes
 * a project root. The shipped {@link catalogAdapter} passes the local stores,
 * which read the context's root when called and call the founding catalog store
 * and payload reader. `AdapterContext.root` stays the compatibility handle a host
 * adapter receives.
 */

import { segmentedOperationCatalogFor } from "../../history/operation-catalog-read.js";
import {
  appendCatalogRecordLocked, createCatalogRecord, findCatalogRecordByMutation, readCatalogStore,
  type CatalogAppendResult, type CatalogRecord, type CatalogStoreRead,
} from "../catalog-store.js";
import type { BundleId, CatalogRecordId } from "../ids.js";
import {
  defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type AdapterPreflight, type AdapterVerify,
  type OperationObservation, type OperationStoreAdapter,
} from "../adapter-types.js";
import type { CatalogOperationMutation } from "../types.js";
import { readBundlePayload, type PayloadRead } from "./shared.js";

/** What the catalog adapter asks of the project. No member takes a project root. */
export interface CatalogAdapterStores {
  /** One retained bundle payload. */
  readPayload(workspaceId: string, bundleId: BundleId, payloadRef: string): Promise<PayloadRead>;
  /** The workspace's catalog. */
  readCatalog(workspaceId: string): Promise<CatalogStoreRead>;
  /**
   * OPTIONAL: on a `local-indexed` project, the record appended for one
   * mutation through the segmented catalog's index (`{ record }`, `record`
   * absent when none), or `null` elsewhere (then `readCatalog` is used).
   */
  findByMutation?(workspaceId: string, mutationId: string): Promise<{ record?: CatalogRecord } | null>;
  /** Append one record through the whole-file-rewrite seam; the caller holds the project lock. */
  append(workspaceId: string, record: CatalogRecord): Promise<CatalogAppendResult>;
}

/** LOCAL DISK. The founding catalog store and payload reader, reading the context's root when called. */
function diskCatalogAdapterStores(ctx: Pick<AdapterContext, "root">): CatalogAdapterStores {
  return {
    readPayload: (workspaceId, bundleId, payloadRef) => readBundlePayload(ctx.root, workspaceId, bundleId, payloadRef),
    readCatalog: (workspaceId) => readCatalogStore(ctx.root, workspaceId),
    findByMutation: async (workspaceId, mutationId) => {
      const segmented = await segmentedOperationCatalogFor(ctx.root, workspaceId);
      if (segmented === null) return null;
      const record = await segmented.findByMutation(mutationId);
      return record === undefined ? {} : { record };
    },
    append: (workspaceId, record) => appendCatalogRecordLocked(ctx.root, workspaceId, record),
  };
}

/** Read the immutable payload bound to this catalog mutation. */
function readPayload(stores: CatalogAdapterStores, ctx: AdapterContext<CatalogOperationMutation>): Promise<PayloadRead> {
  return stores.readPayload(ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/** Observe catalog state by the deterministic mutation identity. */
async function observeCatalog(stores: CatalogAdapterStores, ctx: AdapterContext<CatalogOperationMutation>): Promise<OperationObservation> {
  let existing: CatalogRecord | undefined;
  try {
    const indexed = await stores.findByMutation?.(ctx.manifest.workspaceId, ctx.auditBinding.mutationId);
    if (indexed) existing = indexed.record;
    else {
      const read = await stores.readCatalog(ctx.manifest.workspaceId);
      if (read.status === "unavailable" || read.status === "invalid") return { outcome: "unavailable", detail: "catalog is unreadable" };
      existing = findCatalogRecordByMutation(read.status === "ok" ? read.records : [], ctx.auditBinding.mutationId);
    }
  } catch {
    return { outcome: "unavailable", detail: "catalog is unreadable" };
  }
  // A catalog record is keyed by mutationId, so its presence proves this run produced it.
  return existing === undefined ? { outcome: "not-applied" } : { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true };
}

/** Classify a catalog append failure as unavailable (store fault) or conflict. */
function classifyAppendError(error: unknown): { status: "unavailable" | "conflict"; detail: string } {
  const message = error instanceof Error ? error.message : "catalog append failed";
  return { status: message.includes("unavailable") || message.includes("invalid") ? "unavailable" : "conflict", detail: message };
}

/** Preflight: the payload must be readable JSON. */
async function preflightCatalog(stores: CatalogAdapterStores, ctx: AdapterContext<CatalogOperationMutation>): Promise<AdapterPreflight> {
  const payload = await readPayload(stores, ctx);
  if (payload.kind !== "ok") return { status: "unavailable", detail: "catalog payload is unreadable" };
  try { JSON.parse(payload.bytes.toString("utf8")); }
  catch { return { status: "park", code: "bundle-precondition-conflict", detail: "catalog payload is not JSON" }; }
  return { status: "ready" };
}

/** Apply: build the closed record (an invalid one is a conflict), then append; the same record again is a bound skip. */
async function applyCatalog(stores: CatalogAdapterStores, ctx: AdapterContext<CatalogOperationMutation>): Promise<AdapterApply> {
  const payload = await readPayload(stores, ctx);
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
    const result = await stores.append(ctx.manifest.workspaceId, record);
    return result === "same"
      ? { status: "skipped-idempotent", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true }
      : { status: "applied", postStateDigest: ctx.mutation.postcondition.digest };
  } catch (error) {
    return classifyAppendError(error);
  }
}

/** Verify: the observation, restated as a verdict. */
async function verifyCatalog(stores: CatalogAdapterStores, ctx: AdapterContext<CatalogOperationMutation>): Promise<AdapterVerify> {
  const observation = await observeCatalog(stores, ctx);
  if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "catalog unreadable" };
  return { status: "mismatch", detail: observation.detail ?? "catalog postcondition not met" };
}

/** The catalog adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function defineCatalogAdapter(storesOf: (ctx: AdapterContext<CatalogOperationMutation>) => CatalogAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"catalog-record">({
    kind: "catalog-record",
    preflight: (ctx) => preflightCatalog(storesOf(ctx), ctx),
    observe: (ctx) => observeCatalog(storesOf(ctx), ctx),
    apply: (ctx) => applyCatalog(storesOf(ctx), ctx),
    verify: (ctx) => verifyCatalog(storesOf(ctx), ctx),
  });
}

/** The shipped catalog adapter: the body over the local stores for each context's root. */
export const catalogAdapter: OperationStoreAdapter = defineCatalogAdapter(diskCatalogAdapterStores);
