/**
 * @file src/operation-bundles/adapters/artifact.ts
 * @description The artifact store adapter. It observes the artifact body, its
 * manifest, and the bound audit event, and applies through the existing
 * `applyArtifactLocked` authority with the out-of-band binding threaded so the
 * child event is matched back to its mutation on crash replay.
 */

import { readEvents } from "../../events/store-read.js";
import { applyArtifactLocked, ArtifactWriteDeniedError, ArtifactWriteRefusedError } from "../../artifacts/apply.js";
import { artifactPaths, readArtifactBody, readArtifactManifest } from "../../artifacts/store.js";
import type { ArtifactPlannedMutation } from "../../trust/planner.js";
import type { ArtifactTypeDef } from "../../profile/types.js";
import { defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type OperationObservation, type OperationStoreAdapter } from "../adapter-types.js";
import type { ArtifactOperationMutation } from "../types.js";
import { applyResultFromObservation, digestBytes, loadProfileOrUndefined, readBundlePayload, toOperationBinding, type PayloadRead } from "./shared.js";

/** Resolve the declared artifact type def, or undefined when absent. */
async function artifactDef(root: string, artifactType: string): Promise<ArtifactTypeDef | undefined> {
  const profile = await loadProfileOrUndefined(root);
  return profile?.artifacts?.[artifactType];
}

/** Read the immutable payload bound to this artifact mutation. */
function readPayload(ctx: AdapterContext<ArtifactOperationMutation>): Promise<PayloadRead> {
  return readBundlePayload(ctx.root, ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/** Count bound artifact-write events for this mutation. */
async function boundArtifactEvents(root: string, mutationId: string): Promise<number> {
  const { events } = await readEvents(root);
  return events.filter((event) => event.type === "artifact-write" && event.operationBinding?.mutationId === mutationId).length;
}

/** Read the artifact manifest + body: a terminal observation, or "present" to continue. */
async function readArtifactPresence(ctx: AdapterContext<ArtifactOperationMutation>, def: ArtifactTypeDef, paths: ReturnType<typeof artifactPaths>): Promise<OperationObservation | "present"> {
  const manifest = await readArtifactManifest(ctx.root, paths);
  if (manifest.kind === "unavailable" || manifest.kind === "malformed") return { outcome: "unavailable", detail: "artifact manifest is unreadable" };
  if (manifest.kind === "absent") return { outcome: "not-applied" };
  const body = await readArtifactBody(ctx.root, paths, def.maxBytes);
  if (body.kind === "unavailable" || body.kind === "oversize") return { outcome: "unavailable", detail: "artifact body is unreadable" };
  if (body.kind === "absent") return { outcome: "partially-applied", detail: "manifest present, body missing" };
  if (digestBytes(Buffer.from(body.body, "utf8")) !== ctx.mutation.postcondition.digest) return { outcome: "conflict", detail: "artifact body digest mismatch" };
  return "present";
}

/** Observe artifact state by manifest, body digest, and the bound audit event. */
async function observeArtifact(ctx: AdapterContext<ArtifactOperationMutation>): Promise<OperationObservation> {
  const def = await artifactDef(ctx.root, ctx.mutation.target.artifactType);
  if (!def) return { outcome: "unavailable", detail: "artifact type is undeclared" };
  let paths: ReturnType<typeof artifactPaths>;
  try { paths = artifactPaths(ctx.root, ctx.mutation.target.artifactType, ctx.mutation.target.logicalId, def.fileName); }
  catch { return { outcome: "unavailable", detail: "artifact path is invalid" }; }
  const presence = await readArtifactPresence(ctx, def, paths);
  if (presence !== "present") return presence;
  let bound: number;
  try { bound = await boundArtifactEvents(ctx.root, ctx.auditBinding.mutationId); }
  catch { return { outcome: "unavailable", detail: "event store is unreadable" }; }
  if (bound > 1) return { outcome: "conflict", detail: "duplicate artifact event for mutation" };
  // `applied` requires a bound artifact-write event for THIS mutation, so the effect is this run's.
  return bound === 1
    ? { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true }
    : { outcome: "partially-applied", auditRepairOnly: true, detail: "artifact present, audit event missing" };
}

/** Map an applyArtifactLocked failure to an apply result. */
function classifyArtifactApplyError(error: unknown): AdapterApply {
  if (error instanceof ArtifactWriteDeniedError) return { status: "conflict", detail: error.message };
  if (error instanceof ArtifactWriteRefusedError) return { status: "unavailable", detail: error.message };
  return { status: "unavailable", detail: error instanceof Error ? error.message : "artifact apply failed" };
}

export const artifactAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"artifact">({
  kind: "artifact",

  async preflight(ctx) {
    if ((await artifactDef(ctx.root, ctx.mutation.target.artifactType)) === undefined) {
      return { status: "unavailable", detail: "artifact type is undeclared" };
    }
    const payload = await readPayload(ctx);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "artifact payload is unreadable" };
    if (digestBytes(payload.bytes) !== ctx.mutation.postcondition.digest) {
      return { status: "park", code: "bundle-precondition-conflict", detail: "artifact payload digest mismatch" };
    }
    return { status: "ready" };
  },

  observe: observeArtifact,

  async apply(ctx) {
    const payload = await readPayload(ctx);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "artifact payload is unreadable" };
    const planned: ArtifactPlannedMutation = {
      kind: "artifact", artifactType: ctx.mutation.target.artifactType,
      slug: ctx.mutation.target.logicalId, body: payload.bytes.toString("utf8"), origin: "sdk",
    };
    try { await applyArtifactLocked(ctx.root, planned, toOperationBinding(ctx.auditBinding)); }
    catch (error) { return classifyArtifactApplyError(error); }
    return applyResultFromObservation(await observeArtifact(ctx), ctx.mutation.postcondition.digest);
  },

  async verify(ctx) {
    const observation = await observeArtifact(ctx);
    if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
    if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "artifact unreadable" };
    return { status: "mismatch", detail: observation.detail ?? "artifact postcondition not met" };
  },
});
