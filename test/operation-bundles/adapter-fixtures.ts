/**
 * @file test/operation-bundles/adapter-fixtures.ts
 * @description Shared fixtures for the operation store-adapter tests: a binding,
 * a digest helper, a minimal adapter context, and payload publication into the
 * immutable bundle store. Not a test file.
 */

import { createHash } from "node:crypto";
import { expect } from "bun:test";
import { catalogRecordId, mintBundleId, mintOperationRunId, mutationId, type BundleId, type MutationId } from "../../src/operation-bundles/ids.js";
import { operationAuditBinding, type OperationAuditBinding } from "../../src/operation-bundles/audit-binding.js";
import { writePayloadCreateOnly } from "../../src/operation-bundles/payload-store.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import type { OperationAuthoritySnapshot } from "../../src/operation-bundles/authority.js";
import type {
  ArtifactOperationMutation, CatalogOperationMutation, LifecycleOperationMutation, OperationBundleManifest, OperationDigest, OperationMutation,
  ProjectionOperationMutation, RelationOperationMutation,
} from "../../src/operation-bundles/types.js";
import { buildRelationRef } from "../../src/relations/store.js";
import { hashArtifactBody } from "../../src/artifacts/store.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";

export const WORKSPACE_ID = "ws-adapter";

/** Digest exact bytes into the protocol representation. */
export function digestOf(bytes: Buffer): OperationDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as OperationDigest;
}

/** A distinct bundle/run/mutation identity set for one adapter test. */
export interface BindingSet {
  bundleId: BundleId;
  binding: OperationAuditBinding;
  onDisk: OperationBinding & { mutationId: MutationId };
}

export function makeBinding(index = 0): BindingSet {
  const bundleId = mintBundleId();
  const runId = mintOperationRunId();
  const id = mutationId(bundleId, index);
  const binding = operationAuditBinding({ runId, bundleId, manifestDigest: "sha256:00".padEnd(71, "0") as OperationDigest, workspaceId: WORKSPACE_ID, keyEpochId: "sha256:00".padEnd(71, "0") as OperationDigest }, id);
  return { bundleId, binding, onDisk: { bundleId, runId, mutationId: id } };
}

const DUMMY_DIGEST = "sha256:".concat("0".repeat(64)) as OperationDigest;

function snapshot(): OperationAuthoritySnapshot {
  return {
    profileDigest: DUMMY_DIGEST, operationsAuthorityDigest: DUMMY_DIGEST, actionDescriptorDigest: DUMMY_DIGEST,
    grantDigest: DUMMY_DIGEST, safetyFloorDigest: DUMMY_DIGEST, manifestDigest: DUMMY_DIGEST,
    payloadSetDigest: DUMMY_DIGEST, boundsDigest: DUMMY_DIGEST, adapterCapabilityDigest: DUMMY_DIGEST,
    keyEpochId: DUMMY_DIGEST, storeHealthDigest: DUMMY_DIGEST, preconditionDigest: DUMMY_DIGEST,
  };
}

/** Build a manifest carrying exactly the one mutation under test. */
function manifestFor(bundleId: BundleId, runId: string, mutation: OperationMutation): OperationBundleManifest {
  return {
    schemaVersion: 1, bundleId, runId: runId as OperationBundleManifest["runId"], workspaceId: WORKSPACE_ID,
    createdAt: "2026-07-19T00:00:00.000Z", createdBy: "test",
    knowledgeAuthority: { id: "k", digest: DUMMY_DIGEST },
    operationsAuthority: { packId: "p", packDigest: DUMMY_DIGEST, actionId: "a", actionDescriptorDigest: DUMMY_DIGEST },
    grantDigest: DUMMY_DIGEST, safetyFloorDigest: DUMMY_DIGEST, inputs: [], preparationEvidence: [], bounds: [],
    completeness: { attempted: 1, completed: 0, skipped: 0, failed: 0, requiredMissing: 0, optionalMissing: 0, rationaleDigest: DUMMY_DIGEST },
    reconciliations: [], mutations: [mutation], planningWarnings: [],
  };
}

/** Assemble a full adapter context around one mutation and binding. */
export function makeContext(root: string, mutation: OperationMutation, set: BindingSet): AdapterContext {
  return {
    root, workspaceId: WORKSPACE_ID, manifest: manifestFor(set.bundleId, set.onDisk.runId, mutation),
    mutation, authority: snapshot(), auditBinding: set.binding, clock: { now: () => new Date() },
  };
}

/** Publish an immutable payload blob and return its content-address digest. */
export async function publishPayload(root: string, bundleId: BundleId, bytes: Buffer): Promise<string> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writePayloadCreateOnly(root, { workspaceId: WORKSPACE_ID, bundleId, digest }, bytes);
  return digest;
}

const RECIPE_DIGEST = `sha256:${"5".repeat(64)}` as OperationDigest;

/** A required projection mutation whose declared output digest is its deterministic render's. */
export function projectionMutation(set: BindingSet): ProjectionOperationMutation {
  const target = { recipeId: "recipe-a", recipeDigest: RECIPE_DIGEST, output: "out.json" };
  return {
    kind: "projection", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "render", target: { ...target, criticality: "required" },
    precondition: { kind: "absent" }, postcondition: { digest: digestOf(canonicalBytes(target)) },
  };
}

/** The JSON payload a catalog mutation's record carries. */
export const CATALOG_PAYLOAD = Buffer.from(JSON.stringify({ title: "record a" }));

/** A catalog create of logical record `rec-a` from {@link CATALOG_PAYLOAD}. */
export function catalogMutation(set: BindingSet): CatalogOperationMutation {
  return {
    kind: "catalog-record", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { logicalRecordId: "rec-a" }, payloadRef: createHash("sha256").update(CATALOG_PAYLOAD).digest("hex"),
    precondition: { kind: "absent" }, postcondition: { digest: `sha256:${"4".repeat(64)}` as OperationDigest, recordId: catalogRecordId(set.binding.mutationId) },
  };
}

/** A profile declaring the `note` artifact type (`note.txt`, text, 64 KiB). */
export const ARTIFACT_PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research", entities: { note: { directory: "wiki/note" } },
  artifacts: { note: { fileName: "note.txt", contentKind: "text", maxBytes: 65_536 } },
};

/** The body an artifact mutation writes. */
export const ARTIFACT_BODY = "note contents\n";

/** An artifact create of `note/a` with {@link ARTIFACT_BODY}. */
export function artifactMutation(set: BindingSet): ArtifactOperationMutation {
  return {
    kind: "artifact", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { artifactType: "note", logicalId: "a" }, payloadRef: hashArtifactBody(ARTIFACT_BODY),
    precondition: { kind: "absent" },
    postcondition: { digest: digestOf(Buffer.from(ARTIFACT_BODY, "utf8")), manifestDigest: digestOf(Buffer.from("m")), auditDigest: digestOf(Buffer.from("a")) },
  };
}

/** A profile whose `docs` type has a draft -> published lifecycle. */
export const LIFECYCLE_PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research",
  entities: { docs: { directory: "wiki/docs", lifecycle: { field: "status", initial: "draft", terminal: ["published"], transitions: { draft: ["published"], published: [] } } } },
};

/** The `docs/a` page before, after, and in neither lifecycle state. */
export const LIFECYCLE_PRE = Buffer.from("---\nstatus: draft\n---\nbody\n");
export const LIFECYCLE_POST = Buffer.from("---\nstatus: published\n---\nbody\n");
export const LIFECYCLE_OTHER = Buffer.from("---\nstatus: archived\n---\nbody\n");

/** A draft -> published transition of `docs/a`. */
export function lifecycleMutation(set: BindingSet): LifecycleOperationMutation {
  return {
    kind: "lifecycle-transition", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "transition", target: { entityType: "docs", slug: "a" },
    precondition: { kind: "state", state: "draft", pageDigest: digestOf(LIFECYCLE_PRE) },
    postcondition: { state: "published", pageDigest: digestOf(LIFECYCLE_POST), eventDigest: `sha256:${"2".repeat(64)}` as OperationDigest },
  };
}

/** A profile with a symmetric `related` relation between experiments and ideas. */
export const RELATION_PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "research",
  entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
  relations: { related: { from: ["experiments", "ideas"], to: ["experiments", "ideas"], direction: "symmetric" } },
};

/** The `related` relation a relation mutation declares. */
export const RELATION_INPUT = { type: "related", from: "experiments/a" as EntityId, to: "ideas/b" as EntityId };

/**
 * A relation create of {@link RELATION_INPUT} promising `rel_x`. Its postcondition
 * digest is the store's own content hash for a declared type, and a dummy for any
 * other `relationType`.
 */
export function relationMutation(set: BindingSet, relationType = "related"): RelationOperationMutation {
  const canonical = `sha256:${buildRelationRef(RELATION_PROFILE, RELATION_INPUT).contentHash}` as OperationDigest;
  return {
    kind: "relation", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { relationType, from: "experiments/a", to: "ideas/b" }, attributes: {},
    precondition: { kind: "absent" }, postcondition: { digest: relationType === "related" ? canonical : `sha256:${"1".repeat(64)}` as OperationDigest, recordId: "rel_x" },
  };
}

/**
 * Each fault an adapter's authority throws, other than its own typed refusals,
 * makes apply `unavailable` carrying the fault's message. `applyWith` runs apply
 * with the authority throwing one fault and returns the verdict.
 */
export async function expectApplyFaultsUnavailable(applyWith: (fault: Error) => Promise<unknown>, faults: Error[]): Promise<void> {
  for (const fault of faults) expect(await applyWith(fault)).toEqual({ status: "unavailable", detail: fault.message });
}
