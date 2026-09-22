/**
 * @file test/preparations/attempt-fixture.ts
 * @description Shared harness for the Task 4 three-leg attempt suites. It stages
 * one durable preparation (key, manifest, genesis run, seed evidence) on a real
 * temp root, then builds attempt-execution requests over a fake host-owned
 * authority resolver, deterministic clocks, fake provider/host legs, and a
 * raw-lock probe so a test can assert the project lock is never held while an
 * execution leg runs. The executor is read from the staged plan phase, so the
 * fixture's resolver only supplies the authority digests, never the executor.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import type {
  AttemptAuthorityResolverV1, AttemptExecutionRequestV1, AttemptLegOutcomeV1,
  HostHandlerResultV1, PreparationHostHandlerRegistryV1, SealAuthorityExtrasV1,
} from "../../src/preparations/attempts/types.js";
import type { ProviderInvocationRequestV1 } from "../../src/capability-providers/runtime/invoke.js";
import { providerInputSpecsContentExposureDigest, type ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import type { PreparationEvidenceLocation } from "../../src/preparations/evidence-store.js";
import { fixturePlan, stageRequest } from "./store-fixture.js";

export const PIN = parseSha256Digest(`sha256:${"a".repeat(64)}`);
/** The empty input-spec content-exposure digest, so the provider exposure bind holds. */
export const EXPOSURE = providerInputSpecsContentExposureDigest([]);
const PRINCIPAL = { id: "operator", surface: "cli" } as const;

/** A durable staged preparation and the binding its runs are addressed by. */
export interface StagedPreparation {
  root: string;
  binding: PreparationRunBinding;
  manifestDigest: `sha256:${string}`;
  cleanup(): Promise<void>;
}

/** Stage a durable preparation whose `collect` phase permits broker requests. */
export function stageBrokerCapable(): Promise<StagedPreparation> {
  return stagePreparation(fixturePlan((plan) => {
    (plan as { bounds: Record<string, number> }).bounds.maximumBrokerRequests = 20;
    for (const phase of plan.phases as Array<{ logicalPhaseId: string; bounds: Record<string, number> }>) {
      if (phase.logicalPhaseId === "collect") phase.bounds.maximumBrokerRequestsPerAttempt = 2;
    }
  }));
}

/**
 * Stage one durable preparation into an EXISTING root and bind its run. Owns no
 * root, so it cleans nothing up; the caller that created the root owns that. Use
 * it to put a second preparation — or one in another workspace — beside an
 * existing one, so a project-wide sweep sees more than a single run.
 */
export async function stagePreparationIn(root: string, plan: unknown = fixturePlan()): Promise<StagedPreparation> {
  const result = await stagePreparationLocked(root, stageRequest(plan as never));
  if (result.status !== "staged") throw new Error(`staging failed: ${result.status}`);
  const key = await readPreparationKey(root);
  if (key.status !== "ok") throw new Error("staged key unavailable");
  const binding: PreparationRunBinding = {
    runId: result.manifest.runId, preparationId: result.manifest.preparationId,
    manifestDigest: result.manifestDigest, workspaceId: result.manifest.workspaceId, keyEpochId: key.keyEpochId,
  };
  return { root, binding, manifestDigest: result.manifestDigest, cleanup: async () => {} };
}

/**
 * Stage a preparation and drive one committed attempt so the run is `running` —
 * the shared setup for tests that act on a running run (gate lifecycle,
 * finalization). Throws if the fixture attempt does not commit.
 */
export async function stageRunningPreparation(plan: unknown = fixturePlan()): Promise<StagedPreparation> {
  const staged = await stagePreparation(plan);
  const outcome = await executePhaseAttempt(attemptRequest(staged));
  if (outcome.status !== "committed") throw new Error(`fixture attempt: ${outcome.status}`);
  return staged;
}

/** Stage one durable preparation on a fresh temp root (honest, nonzero bounds). */
export async function stagePreparation(plan: unknown = fixturePlan()): Promise<StagedPreparation> {
  const root = await mkdtemp(path.join(tmpdir(), "prep-attempt-"));
  const staged = await stagePreparationIn(root, plan);
  return { ...staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A strictly increasing ISO clock so every transition timestamp is distinct. */
function makeClock(start = Date.UTC(2026, 6, 21, 0, 0, 0)): { now(): string } {
  let tick = 0;
  return { now: () => new Date(start + tick++ * 1000).toISOString() };
}

/** The stable phase-instance id for one logical phase's single expansion. */
export function phaseInstanceIdFor(binding: PreparationRunBinding, logicalPhaseId: string) {
  return derivePhaseInstanceId({
    manifestDigest: binding.manifestDigest, logicalPhaseId, expansionIdentity: singleExpansionIdentity(),
  });
}

/** The default authority extras for the provider `collect` phase (pin matches PIN). */
export function providerAuthority(overrides: Partial<SealAuthorityExtrasV1> = {}): SealAuthorityExtrasV1 {
  return { inputExposureSetDigest: EXPOSURE, providerPinDigest: PIN, ...overrides };
}

/** A resolver that returns the same extras every time (no drift). */
export function fixedResolver(extras: SealAuthorityExtrasV1 = providerAuthority()): AttemptAuthorityResolverV1 {
  return { resolve: async () => ({ status: "ok", extras }) };
}

/** A resolver returning `first` on the seal call and `second` on the leg-K call. */
export function driftingResolver(first: SealAuthorityExtrasV1, second: SealAuthorityExtrasV1): AttemptAuthorityResolverV1 {
  let calls = 0;
  return { resolve: async () => ({ status: "ok", extras: calls++ === 0 ? first : second }) };
}

/**
 * A provider invocation carrying the fixture's sealed authority: the `collect`
 * phase pins PIN, capability `gather`, schema PIN, and an empty input-spec set.
 * Overrides let a test drift one dimension to prove the leg fails closed.
 */
export function providerRequest(overrides: {
  pin?: `sha256:${string}`; capabilityId?: string; inputSpecs?: readonly unknown[];
  effectPlan?: unknown; operationContext?: Record<string, unknown>; launchParentDir?: string;
  brokers?: Record<string, unknown>; resourceBounds?: Record<string, unknown>;
  operationsPackRequest?: Record<string, unknown>;
} = {}): ProviderInvocationRequestV1 {
  const capabilityId = overrides.capabilityId ?? "gather";
  return {
    paths: { verification: "authorized-provider-roots" }, invocationId: "inv-1", nonce: "nonce-1",
    expectedIdentity: { providerPinDigest: overrides.pin ?? PIN, capabilityId, capabilitySchemaDigest: PIN },
    authorityRequest: {
      capabilityId, ...(overrides.effectPlan === undefined ? {} : { effectPlan: overrides.effectPlan }),
      ...(overrides.resourceBounds === undefined ? {} : { resourceBounds: overrides.resourceBounds }),
      ...(overrides.operationsPackRequest === undefined ? {} : { operationsPackRequest: overrides.operationsPackRequest }),
    },
    launch: {
      sourceTreeReal: "/src", launchParentDir: overrides.launchParentDir ?? "/caller-launch",
      artifact: { artifactId: "test-artifact", os: "linux", architecture: "x64", entrypointRelativePath: "entry.js", artifactDigest: PIN, archiveFormat: "tar", archiveByteCount: 1, expandedTreeDigest: PIN, expandedByteCount: 1, entryCount: 1 },
    },
    inputSpecs: overrides.inputSpecs ?? [], input: null, operationContext: overrides.operationContext ?? {},
    declaredOutputs: [], custodyValidators: [], brokers: overrides.brokers ?? {},
  } as unknown as ProviderInvocationRequestV1;
}

/** The preparation evidence destination for one staged preparation. */
export function evidenceLocation(staged: StagedPreparation): PreparationEvidenceLocation {
  return { workspaceId: staged.binding.workspaceId, preparationId: staged.binding.preparationId };
}

/** A wide bounds block for a synthetic sealed context in leg unit tests. */
export function wideBounds(maximumOutputEvidenceBytes = 1 << 20) {
  return {
    maximumAttempts: 2, maximumInvocationsPerAttempt: 1, maximumBrokerRequestsPerAttempt: 0,
    maximumEffectsPerAttempt: 0, maximumTransitionsPerInstance: 4, maximumOutputEvidenceBytes,
    maximumCheckpointBytes: 0, maximumTokensPerAttempt: 100, maximumTimeMsPerInstance: 4_000_000_000,
    maximumCostMicrosPerAttempt: 10,
  };
}

/** Build one provider-phase attempt request over an injected leg runner. */
export function attemptRequest(
  staged: StagedPreparation, overrides: Partial<AttemptExecutionRequestV1> = {},
): AttemptExecutionRequestV1 {
  const logicalPhaseId = "collect";
  return {
    root: staged.root, binding: staged.binding, phaseInstanceId: phaseInstanceIdFor(staged.binding, logicalPhaseId),
    logicalPhaseId, attemptIndex: 0, authorityResolver: fixedResolver(),
    leg: async () => succeededLeg(), principal: PRINCIPAL, clock: makeClock(), ...overrides,
  };
}

/**
 * A completed provider invocation returning the given accepted artifacts under
 * the given host-observed usage — the one place the admitted-result shape every
 * leg suite feeds through `admitProviderLeg` is written down.
 */
export function completedProviderInvoke(
  acceptedArtifacts: readonly unknown[] = [],
  usage: { brokerRequestCount: number; tokenCount: number | "unobserved"; costMicros: number | "unobserved" }
    = { brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" },
): ProviderInvokeFn {
  return async () => ({ kind: "completed", admitted: {
    outcome: "succeeded", acceptedArtifacts,
    counts: { declared: acceptedArtifacts.length, acceptedArtifacts: acceptedArtifacts.length, requiredMissing: 0, receipts: 0 },
    receipts: [], usage, untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null },
  } } as never);
}

/** A minimal succeeded leg outcome with no artifacts, receipts, or checkpoints. */
export function succeededLeg(): AttemptLegOutcomeV1 {
  return {
    phaseState: "succeeded", pendingEvidence: [], effects: [], invocationCount: 1, brokerRequestCount: 0,
    tokenCount: 0, costMicros: 0, observedProviderPinDigest: PIN,
  };
}

/** Probe whether the project lock is currently free (acquire then release). */
export async function lockIsFree(root: string): Promise<boolean> {
  const got = await acquireLock(root, { quiet: true });
  if (got) await releaseLock(root);
  return got;
}

/** A fake host-handler registry whose descriptor binds the requested ref exactly. */
export function fakeRegistry(result?: () => Promise<HostHandlerResultV1>): PreparationHostHandlerRegistryV1 {
  return {
    resolve: (ref) => ({
      handler: { execute: async () => (result ? result() : { kind: "completed", succeededWithWarnings: false, outputs: [] }) },
      descriptor: {
        handlerId: ref.handlerId, handlerContractVersion: ref.handlerContractVersion,
        handlerContractDigest: ref.handlerContractDigest, effectClass: "pure", deterministic: true,
        maximumOutputBytes: 1 << 20, maximumWallTimeMs: 1000, recovery: "restart-safe",
      },
    }),
  };
}
