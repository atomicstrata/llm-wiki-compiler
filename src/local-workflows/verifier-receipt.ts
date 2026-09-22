/**
 * @file src/local-workflows/verifier-receipt.ts
 * @description Mints durable verifier receipts only after a process-pinned host
 * implementation accepts healthy artifact evidence. Core derives all authority,
 * target, chain, and digest fields; callers can provide only the raw artifact ref.
 */

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { canonicalBytes, canonicalDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { parseArtifactRef, formatArtifactRef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { resolveProcessVerifierPin } from "./process-definition.js";
import { withHostRunLock, isTerminalStatus } from "./with-lock.js";
import { serializeRunWithinCap } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { RunNotActiveError } from "./errors.js";
import {
  WorkflowVerifierError, type HostVerifierRegistryV1, type HostVerifierAcceptedV1,
} from "./verifier-registry.js";
import type { WorkflowRun, VerifierReceiptV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

const MAX_NORMALIZED_BYTES = 65_536;
const MAX_BOUND_VALUES = 64;
const MAX_BOUND_REFS = 64;

/** Canonical chain root over outputs through and including `outputStageId`. */
export function predecessorChainRoot(run: WorkflowRun, outputStageId: string): string {
  const ids = run.stageLog.map((entry) => entry.stageId);
  const last = ids.indexOf(outputStageId);
  if (last < 0) throw new WorkflowVerifierError("output-stage-unknown");
  return canonicalDigest(ids.slice(0, last + 1).map((stageId) => ({
    stageId, output: Object.hasOwn(run.outputs, stageId) ? run.outputs[stageId] : null,
  })));
}

/** Bound and canonicalize the normalized verifier envelope. */
function assertNormalizedEnvelope(result: HostVerifierAcceptedV1): void {
  if (canonicalBytes(result.normalizedEnvelope).byteLength > MAX_NORMALIZED_BYTES) {
    throw new WorkflowVerifierError("normalized-envelope-oversize");
  }
}

/** Require a small string-only generic binding map. */
function assertBoundValues(result: HostVerifierAcceptedV1): void {
  const values = Object.entries(result.boundValues);
  if (values.length > MAX_BOUND_VALUES
    || values.some(([key, value]) => key.length === 0 || typeof value !== "string")) {
    throw new WorkflowVerifierError("bound-values-malformed");
  }
}

/** Bound the two optional reference lists. */
function assertReferenceCounts(result: HostVerifierAcceptedV1): void {
  if ((result.liveTargetPageIds?.length ?? 0) > MAX_BOUND_REFS
    || (result.boundArtifactRefs?.length ?? 0) > MAX_BOUND_REFS) {
    throw new WorkflowVerifierError("bound-references-oversize");
  }
}

/** Validate generic verifier output before any part enters authority. */
function validateAccepted(result: HostVerifierAcceptedV1): void {
  assertNormalizedEnvelope(result);
  assertBoundValues(result);
  assertReferenceCounts(result);
}

/** Require the stage's recorded artifact output to equal the supplied raw ref. */
function assertRecordedArtifact(run: WorkflowRun, stageId: string, compactRef: string): void {
  const output = run.outputs[stageId];
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new WorkflowVerifierError("artifact-output-missing");
  }
  const row = output as Record<string, unknown>;
  const recorded = `${row.artifactType}/${row.slug}@sha256:${row.sha256}`;
  if (recorded !== compactRef) throw new WorkflowVerifierError("artifact-output-mismatch");
}

/** Verify every additional artifact ref named by an accepted verifier result. */
async function boundArtifacts(host: LocalWorkflowHost, root: string, refs: readonly string[]): Promise<string[]> {
  const profile = (await host.profiles.load(root)).profile;
  const normalized: string[] = [];
  for (const raw of refs) {
    const ref = parseArtifactRef(raw);
    if (ref === null || (await host.observations.artifact(root, profile, ref)).health !== "ok") {
      throw new WorkflowVerifierError("bound-artifact-unhealthy");
    }
    normalized.push(formatArtifactRef(ref));
  }
  return normalized;
}

/** Build the receipt entirely from host-derived and verifier-derived values. */
async function buildReceipt(
  host: LocalWorkflowHost,
  root: string, run: WorkflowRun, outputStageId: string, rawArtifactRef: string,
  verifierId: string, registry: HostVerifierRegistryV1,
): Promise<VerifierReceiptV1> {
  const authority = run.processAuthority;
  if (authority === undefined) throw new WorkflowVerifierError("process-authority-missing");
  const ref = parseArtifactRef(rawArtifactRef);
  if (ref === null) throw new WorkflowVerifierError("raw-artifact-ref-malformed");
  const compactRef = formatArtifactRef(ref);
  assertRecordedArtifact(run, outputStageId, compactRef);
  const profile = (await host.profiles.load(root)).profile;
  const read = await host.observations.artifactBody(root, profile, ref);
  if (read.health !== "ok" || read.bytes === undefined) {
    throw new WorkflowVerifierError("raw-artifact-unhealthy");
  }
  const pin = await resolveProcessVerifierPin(root, run, verifierId, host.observations.processSource);
  const implementation = registry.resolve(pin.verifierId, pin.implementationDigest);
  const result = await implementation.verify({
    root, run, outputStageId, rawArtifactRef: compactRef, rawArtifactBytes: read.bytes,
  });
  if (result.kind === "rejected") throw new WorkflowVerifierError(result.reasonCode);
  validateAccepted(result);
  const pageIds = [...new Set(result.liveTargetPageIds ?? [])];
  const liveTargets = await Promise.all(pageIds.map((pageId) => host.observations.liveTarget(root, pageId)));
  const boundArtifactRefs = await boundArtifacts(host, root, result.boundArtifactRefs ?? []);
  return {
    schemaVersion: 1, verifierId, verifierImplementationDigest: pin.implementationDigest,
    rawArtifactRef: compactRef, normalizedEnvelope: result.normalizedEnvelope,
    normalizedEnvelopeDigest: canonicalDigest(result.normalizedEnvelope),
    boundValues: { ...result.boundValues }, boundArtifactRefs, liveTargets,
    workflowId: run.workflowId, workflowDigest: run.workflowDigest, runId: run.runId,
    profileDigest: run.profileDigest, processDefinitionDigest: authority.processDefinitionDigest,
    workspaceId: authority.workspaceId,
    workspaceCompositionDigest: authority.workspaceCompositionDigest,
    outputStageId, predecessorChainRoot: predecessorChainRoot(run, outputStageId),
    mintedAt: new Date().toISOString(),
  };
}

/** Mint the same pinned-verifier receipt using host observations and its held transaction. */
export async function mintVerifierReceiptWithHost(host: LocalWorkflowHost,
  root: string, runId: string, outputStageId: string, rawArtifactRef: string,
  verifierId: string, registry: HostVerifierRegistryV1): Promise<VerifierReceiptV1> {
  return withHostRunLock(host, root, runId, async (run, context) => {
    if (isTerminalStatus(run.status)) throw new RunNotActiveError(runId, run.status);
    const existing = run.verifierReceipts?.[outputStageId];
    if (existing !== undefined) {
      if (existing.rawArtifactRef !== rawArtifactRef || existing.verifierId !== verifierId) {
        throw new WorkflowVerifierError("receipt-replay-mismatch");
      }
      return existing;
    }
    const receipt = await buildReceipt(host, root, run, outputStageId, rawArtifactRef, verifierId, registry);
    const updated = { ...run, verifierReceipts: { ...run.verifierReceipts, [outputStageId]: receipt } };
    serializeRunWithinCap(updated);
    await host.records.write(context.transaction, root, updated);
    return receipt;
  });
}
