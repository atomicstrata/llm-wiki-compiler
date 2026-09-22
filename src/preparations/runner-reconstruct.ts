/**
 * @file src/preparations/runner-reconstruct.ts
 * @description The restart/reconstruct read-and-assemble leg of the host runner
 * (runner design v3 §3.4): read the persisted materialization manifest and its
 * payloads back out of the durable evidence store (R1), and assemble the
 * {@link PreparationHandoffRequestV1} purely from that persisted material plus the
 * caller's capabilities. Extracted from `runner.ts` so the driver module stays
 * within the size limit; it holds NO orchestration — `reconstructAndHandoff` still
 * owns the sequencing and calls these pure readers/assemblers.
 *
 * Only TYPES are imported from `runner.ts` (the input + the internal test-fault
 * shape), so there is no runtime import cycle: the runner imports these functions
 * as values; this module imports nothing executable from the runner.
 */

import { readPreparationEvidenceBytes } from "./evidence-store.js";
import {
  parseMaterializationManifest, toOperationEvidenceRef,
  type MaterializationResultV1, type PreparationHandoffMaterializationV1,
} from "./materialization.js";
import type { PreparationHandoffRequestV1 } from "./handoff.js";
import type { PreparationRunV1 } from "./run-types.js";
import type { RunPreparationInputV1, RunnerFaultsForTestV1 } from "./runner.js";

/** R1-read the manifest bytes (prefixed run digest → bare CAS key) and parse. */
export async function readManifestBack(
  input: RunPreparationInputV1, digest: string, cap: number,
): Promise<PreparationHandoffMaterializationV1 | string> {
  const bare = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  const location = { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId };
  const bytes = await readPreparationEvidenceBytes(input.root, location, bare, cap);
  if (bytes.status !== "ok") return `manifest evidence ${bytes.status}`;
  try {
    return parseMaterializationManifest(bytes.bytes);
  } catch (cause) {
    return `manifest unparseable: ${(cause as Error).message}`;
  }
}

/** R1-read every payload the manifest references, keyed by bare CAS digest. */
export async function readPayloadsBack(
  input: RunPreparationInputV1, body: MaterializationResultV1, cap: number,
): Promise<Map<string, Buffer> | string> {
  const location = { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId };
  const payloads = new Map<string, Buffer>();
  for (const ref of body.payloadRefs) {
    const bytes = await readPreparationEvidenceBytes(input.root, location, ref.digest, cap);
    if (bytes.status !== "ok") return `payload ${ref.digest} ${bytes.status}`;
    payloads.set(ref.digest, bytes.bytes);
  }
  return payloads;
}

/** Assemble the handoff request purely from persisted material plus capabilities. */
export function handoffRequest(
  input: RunPreparationInputV1, run: PreparationRunV1,
  manifest: PreparationHandoffMaterializationV1, payloads: Map<string, Buffer>,
  faults: RunnerFaultsForTestV1 | undefined,
): PreparationHandoffRequestV1 {
  const body = manifest.body;
  const payloadDigests = new Set(payloads.keys());
  return {
    binding: input.binding,
    compilation: {
      adapters: input.adapters, contract: input.policyContract,
      targets: body.targets as never, proposals: body.proposals as never,
      reconciliations: body.reconciliations as never, selections: body.selections as never,
      completeness: body.completeness as never,
      ...(body.requiredProposalIds === undefined ? {} : { requiredProposalIds: body.requiredProposalIds }),
    },
    authorities: {
      grantDigest: manifest.grantDigest as never,
      inputs: body.authorityInputs as never, bounds: body.authorityBounds as never,
      operationRun: {
        declaredCompensatorIndexes: body.operationRun.declaredCompensatorIndexes as never,
        controlTransitionAllowance: body.operationRun.controlTransitionAllowance as never,
        actor: manifest.actor as never,
      },
    },
    preparationEvidence: run.evidenceRefs.map((ref) => toOperationEvidenceRef(ref, payloadDigests)),
    payloads,
    actor: input.principal, at: input.clock.now(),
    // Unit G: the materializer's superseding local intent, validated at capture,
    // threaded into the handoff so the bundle records which prior bundle it supersedes.
    ...(body.supersedesBundleId === undefined ? {} : { supersedesBundleId: body.supersedesBundleId }),
    // TEST-ONLY: thread the after-stage crash seam into the hand-off's own boundary
    // so a partial hand-off (`handoff-started`) is produced through the real path.
    ...(faults?.afterStage === undefined ? {} : { faultsForTest: { afterStage: faults.afterStage } }),
  };
}
