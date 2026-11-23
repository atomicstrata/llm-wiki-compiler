/**
 * @file src/operation-bundles/adapters/artifact.ts
 * @description The artifact store adapter. It observes the artifact body, its
 * manifest, and the bound audit event, and applies through the existing
 * `applyArtifactLocked` authority with the out-of-band binding threaded so the
 * child event is matched back to its mutation on crash replay.
 *
 * ONE BODY. {@link defineArtifactAdapter} owns every verdict (the declared type,
 * the payload digest, the manifest/body/bound-event observation and its
 * partial and unavailable arms, the apply failure classes, verify) over
 * {@link ArtifactAdapterStores}, none of which takes a project root. The shipped
 * {@link artifactAdapter} passes the local stores, which read the context's root
 * when called and call the incumbent profile loader, payload reader, artifact
 * path selector and readers, event reader and `applyArtifactLocked`.
 * `AdapterContext.root` stays the compatibility handle a host adapter receives.
 */

import { indexedBoundEvents } from "../../history/bound-lookups.js";
import type { EventRecord } from "../../events/types.js";
import { readEvents, type ReadEventsResult } from "../../events/store-read.js";
import { applyArtifactLocked, ArtifactWriteDeniedError, ArtifactWriteRefusedError } from "../../artifacts/apply.js";
import {
  artifactPaths, readArtifactBody, readArtifactManifest, type ArtifactBodyRead, type ArtifactPathsV1, type ManifestRead,
} from "../../artifacts/store.js";
import type { ArtifactPlannedMutation } from "../../trust/planner.js";
import type { ArtifactTypeDef, ProfilePack } from "../../profile/types.js";
import type { OperationBinding } from "../../utils/operation-binding.js";
import {
  defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type AdapterPreflight, type AdapterVerify,
  type OperationObservation, type OperationStoreAdapter,
} from "../adapter-types.js";
import type { BundleId } from "../ids.js";
import type { ArtifactOperationMutation } from "../types.js";
import { applyResultFromObservation, digestBytes, loadProfileOrUndefined, readBundlePayload, toOperationBinding, type PayloadRead } from "./shared.js";

/** What the artifact adapter asks of the project. No member takes a project root. */
export interface ArtifactAdapterStores {
  /** The active profile, or undefined when none is loadable. */
  loadProfile(): Promise<ProfilePack | undefined>;
  /** One retained bundle payload. */
  readPayload(workspaceId: string, bundleId: BundleId, payloadRef: string): Promise<PayloadRead>;
  /** The artifact's location (a path selector); THROWS for an unsafe type, id or file name. */
  location(artifactType: string, logicalId: string, fileName: string): ArtifactPathsV1;
  /** The artifact's manifest at `location`. */
  readManifest(location: ArtifactPathsV1): Promise<ManifestRead>;
  /** The artifact's body at `location`, within `maxBytes`. */
  readBody(location: ArtifactPathsV1, maxBytes: number): Promise<ArtifactBodyRead>;
  /** The project's audit events. */
  readEvents(): Promise<ReadEventsResult>;
  /** OPTIONAL: the events bound to one mutation via the `local-indexed` binding index, or `null` (then `readEvents` is used). */
  boundEvents?(mutationId: string): Promise<EventRecord[] | null>;
  /** Write through the artifact authority with the out-of-band binding; the caller holds the project lock. */
  applyArtifact(planned: ArtifactPlannedMutation, binding: OperationBinding): Promise<unknown>;
}

/** LOCAL DISK. The incumbent loaders, readers, path selector and artifact authority, each reading the context's root when called. */
function diskArtifactAdapterStores(ctx: Pick<AdapterContext, "root">): ArtifactAdapterStores {
  return {
    loadProfile: () => loadProfileOrUndefined(ctx.root),
    readPayload: (workspaceId, bundleId, payloadRef) => readBundlePayload(ctx.root, workspaceId, bundleId, payloadRef),
    location: (artifactType, logicalId, fileName) => artifactPaths(ctx.root, artifactType, logicalId, fileName),
    readManifest: (location) => readArtifactManifest(ctx.root, location),
    readBody: (location, maxBytes) => readArtifactBody(ctx.root, location, maxBytes),
    readEvents: () => readEvents(ctx.root),
    boundEvents: (mutationId) => indexedBoundEvents(ctx.root, mutationId),
    applyArtifact: (planned, binding) => applyArtifactLocked(ctx.root, planned, binding),
  };
}

/** Resolve the declared artifact type def, or undefined when absent. */
async function artifactDef(stores: ArtifactAdapterStores, artifactType: string): Promise<ArtifactTypeDef | undefined> {
  const profile = await stores.loadProfile();
  return profile?.artifacts?.[artifactType];
}

/** Read the immutable payload bound to this artifact mutation. */
function readPayload(stores: ArtifactAdapterStores, ctx: AdapterContext<ArtifactOperationMutation>): Promise<PayloadRead> {
  return stores.readPayload(ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/** Count bound artifact-write events for this mutation. */
async function boundArtifactEvents(stores: ArtifactAdapterStores, mutationId: string): Promise<number> {
  const events = (await stores.boundEvents?.(mutationId)) ?? (await stores.readEvents()).events;
  return events.filter((event) => event.type === "artifact-write" && event.operationBinding?.mutationId === mutationId).length;
}

/** Read the artifact manifest + body: a terminal observation, or "present" to continue. */
async function readArtifactPresence(stores: ArtifactAdapterStores, ctx: AdapterContext<ArtifactOperationMutation>, def: ArtifactTypeDef, paths: ArtifactPathsV1): Promise<OperationObservation | "present"> {
  const manifest = await stores.readManifest(paths);
  if (manifest.kind === "unavailable" || manifest.kind === "malformed") return { outcome: "unavailable", detail: "artifact manifest is unreadable" };
  if (manifest.kind === "absent") return { outcome: "not-applied" };
  const body = await stores.readBody(paths, def.maxBytes);
  if (body.kind === "unavailable" || body.kind === "oversize") return { outcome: "unavailable", detail: "artifact body is unreadable" };
  if (body.kind === "absent") return { outcome: "partially-applied", detail: "manifest present, body missing" };
  if (digestBytes(Buffer.from(body.body, "utf8")) !== ctx.mutation.postcondition.digest) return { outcome: "conflict", detail: "artifact body digest mismatch" };
  return "present";
}

/** Observe artifact state by manifest, body digest, and the bound audit event. */
async function observeArtifact(stores: ArtifactAdapterStores, ctx: AdapterContext<ArtifactOperationMutation>): Promise<OperationObservation> {
  const def = await artifactDef(stores, ctx.mutation.target.artifactType);
  if (!def) return { outcome: "unavailable", detail: "artifact type is undeclared" };
  let paths: ArtifactPathsV1;
  try { paths = stores.location(ctx.mutation.target.artifactType, ctx.mutation.target.logicalId, def.fileName); }
  catch { return { outcome: "unavailable", detail: "artifact path is invalid" }; }
  const presence = await readArtifactPresence(stores, ctx, def, paths);
  if (presence !== "present") return presence;
  let bound: number;
  try { bound = await boundArtifactEvents(stores, ctx.auditBinding.mutationId); }
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

/** Preflight: a declared type and a payload at the declared digest. */
async function preflightArtifact(stores: ArtifactAdapterStores, ctx: AdapterContext<ArtifactOperationMutation>): Promise<AdapterPreflight> {
  if ((await artifactDef(stores, ctx.mutation.target.artifactType)) === undefined) {
    return { status: "unavailable", detail: "artifact type is undeclared" };
  }
  const payload = await readPayload(stores, ctx);
  if (payload.kind !== "ok") return { status: "unavailable", detail: "artifact payload is unreadable" };
  if (digestBytes(payload.bytes) !== ctx.mutation.postcondition.digest) {
    return { status: "park", code: "bundle-precondition-conflict", detail: "artifact payload digest mismatch" };
  }
  return { status: "ready" };
}

/** Apply: write through the artifact authority with the binding, then re-observe for the verdict. */
async function applyArtifact(stores: ArtifactAdapterStores, ctx: AdapterContext<ArtifactOperationMutation>): Promise<AdapterApply> {
  const payload = await readPayload(stores, ctx);
  if (payload.kind !== "ok") return { status: "unavailable", detail: "artifact payload is unreadable" };
  const planned: ArtifactPlannedMutation = {
    kind: "artifact", artifactType: ctx.mutation.target.artifactType,
    slug: ctx.mutation.target.logicalId, body: payload.bytes.toString("utf8"), origin: "sdk",
  };
  try { await stores.applyArtifact(planned, toOperationBinding(ctx.auditBinding)); }
  catch (error) { return classifyArtifactApplyError(error); }
  return applyResultFromObservation(await observeArtifact(stores, ctx), ctx.mutation.postcondition.digest);
}

/** Verify: the observation, restated as a verdict. */
async function verifyArtifact(stores: ArtifactAdapterStores, ctx: AdapterContext<ArtifactOperationMutation>): Promise<AdapterVerify> {
  const observation = await observeArtifact(stores, ctx);
  if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "artifact unreadable" };
  return { status: "mismatch", detail: observation.detail ?? "artifact postcondition not met" };
}

/** The artifact adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function defineArtifactAdapter(storesOf: (ctx: AdapterContext<ArtifactOperationMutation>) => ArtifactAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"artifact">({
    kind: "artifact",
    preflight: (ctx) => preflightArtifact(storesOf(ctx), ctx),
    observe: (ctx) => observeArtifact(storesOf(ctx), ctx),
    apply: (ctx) => applyArtifact(storesOf(ctx), ctx),
    verify: (ctx) => verifyArtifact(storesOf(ctx), ctx),
  });
}

/** The shipped artifact adapter: the body over the local stores for each context's root. */
export const artifactAdapter: OperationStoreAdapter = defineArtifactAdapter(diskArtifactAdapterStores);
