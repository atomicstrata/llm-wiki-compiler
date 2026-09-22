/**
 * @file test/operation-bundles/adapter-fixtures.ts
 * @description Shared fixtures for the operation store-adapter tests: a binding,
 * a digest helper, a minimal adapter context, and payload publication into the
 * immutable bundle store. Not a test file.
 */

import { createHash } from "node:crypto";
import { mintBundleId, mintOperationRunId, mutationId, type BundleId, type MutationId } from "../../src/operation-bundles/ids.js";
import { operationAuditBinding, type OperationAuditBinding } from "../../src/operation-bundles/audit-binding.js";
import { writePayloadCreateOnly } from "../../src/operation-bundles/payload-store.js";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import type { OperationAuthoritySnapshot } from "../../src/operation-bundles/authority.js";
import type { OperationBundleManifest, OperationDigest, OperationMutation } from "../../src/operation-bundles/types.js";
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
