/**
 * @file test/operation-bundles/run-fixture.ts
 * @description Shared manifest-backed operation-run fixtures whose exact work
 * identities exercise the same derivation used by the production constructor.
 */

import { operationManifestDigest } from "../../src/operation-bundles/manifest-parse.js";
import { mintBundleId, mintOperationRunId, mutationId, type BundleId } from "../../src/operation-bundles/ids.js";
import { createInitialOperationRun, operationKeyEpochId } from "../../src/operation-bundles/run-integrity.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { OperationBundleManifest, OperationDigest, OperationMutation } from "../../src/operation-bundles/types.js";

const DIGEST = `sha256:${"a".repeat(64)}` as OperationDigest;

export interface RunFixtureOptions {
  key: Buffer;
  actor: OperationPrincipal;
  at: string;
  workspaceId?: string;
  authoritativeMutationCount?: number;
  requiredProjectionCount?: number;
  optionalProjectionCount?: number;
  compensatorIndices?: readonly number[];
  controlTransitionAllowance?: number;
  recoversBundleId?: BundleId;
}

/** Build a canonical manifest and the initial run bound to its exact digest. */
export function runFixture(options: RunFixtureOptions) {
  const bundleId = mintBundleId(), runId = mintOperationRunId();
  const workspaceId = options.workspaceId ?? "default";
  const mutations = fixtureMutations(bundleId, options);
  const manifestBase = fixtureManifest(bundleId, runId, workspaceId, options.at, mutations);
  const manifest = options.recoversBundleId === undefined ? manifestBase : { ...manifestBase, recoversBundleId: options.recoversBundleId };
  const manifestDigest = operationManifestDigest(manifest) as OperationDigest;
  const keyEpochId = operationKeyEpochId(options.key);
  const declaredCompensatorMutationIds = (options.compensatorIndices ?? []).map((index) => mutationId(bundleId, index));
  const input = {
    manifest, manifestDigest, keyEpochId, actor: options.actor, at: options.at,
    declaredCompensatorMutationIds,
    controlTransitionAllowance: options.controlTransitionAllowance ?? 32,
  };
  const content = createInitialOperationRun(input);
  const binding = { bundleId, runId, workspaceId, manifestDigest, keyEpochId };
  return { bundleId, runId, manifest, manifestDigest, input, content, binding };
}

/** Build the fixture's authoritative and projection mutation sequence. */
function fixtureMutations(bundleId: ReturnType<typeof mintBundleId>, options: RunFixtureOptions): OperationMutation[] {
  const result: OperationMutation[] = [];
  const authoritative = options.authoritativeMutationCount ?? 0;
  for (let index = 0; index < authoritative; index += 1) result.push(sourceMutation(bundleId, index));
  const required = options.requiredProjectionCount ?? 0;
  for (let offset = 0; offset < required; offset += 1) result.push(projectionMutation(bundleId, result.length, "required"));
  const optional = options.optionalProjectionCount ?? 0;
  for (let offset = 0; offset < optional; offset += 1) result.push(projectionMutation(bundleId, result.length, "optional"));
  return result;
}

/** Build one authoritative retained-source mutation. */
function sourceMutation(bundleId: ReturnType<typeof mintBundleId>, index: number): OperationMutation {
  return {
    index, mutationId: mutationId(bundleId, index), dependsOn: [], reconciliationRefs: [],
    kind: "source-retain", operation: "create", target: { digest: DIGEST }, payloadRef: `payload-${index}`,
    precondition: { kind: "absent-or-same", digest: DIGEST, byteCount: 1 },
    postcondition: { digest: DIGEST, byteCount: 1 },
  };
}

/** Build one projection mutation with its declared criticality. */
function projectionMutation(bundleId: ReturnType<typeof mintBundleId>, index: number, criticality: "required" | "optional"): OperationMutation {
  return {
    index, mutationId: mutationId(bundleId, index), dependsOn: [], reconciliationRefs: [],
    kind: "projection", operation: "render",
    target: { recipeId: `recipe-${index}`, recipeDigest: DIGEST, output: `out-${index}.md`, criticality },
    precondition: { kind: "absent" }, postcondition: { digest: DIGEST },
  };
}

/** Assemble the canonical manifest that owns the fixture run. */
function fixtureManifest(bundleId: ReturnType<typeof mintBundleId>, runId: ReturnType<typeof mintOperationRunId>, workspaceId: string, at: string, mutations: OperationMutation[]): OperationBundleManifest {
  return {
    schemaVersion: 1, bundleId, runId, workspaceId, createdAt: at, createdBy: "fixture",
    knowledgeAuthority: { id: "knowledge", digest: DIGEST },
    operationsAuthority: { packId: "pack", packDigest: DIGEST, actionId: "action", actionDescriptorDigest: DIGEST },
    grantDigest: DIGEST, safetyFloorDigest: DIGEST, inputs: [], preparationEvidence: [], bounds: [],
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0, requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST },
    reconciliations: [], mutations, planningWarnings: [],
  };
}
