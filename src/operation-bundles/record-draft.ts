/** @file Internal record-intent compilation into the existing immutable bundle
 * grammar. This is not a public raw-draft API. It declares one page write and
 * retains both the exact intent and host-owned effect key as bundle payloads. */
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { digestBytes } from "./adapters/shared.js";
import { DEFAULT_OPERATION_CONTROL_TRANSITION_ALLOWANCE } from "./constants.js";
import { recomputeGrantDigest } from "./operations-authority-resolver.js";
import type { OperationPrincipal } from "./principal.js";
import { recordIntentDigest, type RecordIntentV1 } from "./record-intent.js";
import type { OperationBundleDraft, OperationMutationDraft } from "./stage.js";
import type { OperationDigest } from "./types.js";

/** Host identity, not provider attribution, partitions the durable effect key. */
export function recordEffectKeyBytes(intent: RecordIntentV1, preparerId: string): Buffer {
  return canonicalBytes({ workspaceId: intent.workspaceId, preparerId, effectId: intent.effectId });
}

/** Exact byte/preimage declaration for the one supported create/update primitive. */
export function recordPageMutation(intent: RecordIntentV1): OperationMutationDraft {
  const bytes = Buffer.from(intent.proposedBody), digest = digestBytes(bytes);
  return { kind: "page", operation: intent.precondition.kind === "absent" ? "create" : "update",
    target: { kind: "entity", ...intent.target }, payloadRef: digest.slice(7), dependsOn: [], reconciliationRefs: [],
    precondition: intent.precondition, postcondition: { digest, byteCount: bytes.length } };
}

/** Compile host-derived metadata; not-configured policy dimensions are explicit. */
export function compileRecordDraft(intent: RecordIntentV1, principal: OperationPrincipal, profileId: string) {
  const intentBytes = canonicalBytes(intent), keyBytes = recordEffectKeyBytes(intent, principal.id);
  const entries = [["record-intent-v1", intentBytes], ["record-effect-key-v1", keyBytes]] as const;
  const payloads = new Map<string, Buffer>([[digestBytes(Buffer.from(intent.proposedBody)).slice(7), Buffer.from(intent.proposedBody)]]);
  const preparationEvidence = entries.map(([type, bytes]) => {
    const digest = digestBytes(bytes), payloadRef = digest.slice(7); payloads.set(payloadRef, bytes);
    return { type, provenance: "llmwiki-record-preparer-v1", digest, payloadRef, byteCount: bytes.length };
  });
  const notConfigured = (component: string) => canonicalDigest({ component, configured: false }) as OperationDigest;
  const draft: OperationBundleDraft = { workspaceId: intent.workspaceId, createdBy: principal.id,
    knowledgeAuthority: { id: profileId, digest: intent.profileDigest },
    operationsAuthority: { packId: "llmwiki-record-preparer-v1", packDigest: notConfigured("operationsAuthority"),
      actionId: "prepare-record", actionDescriptorDigest: notConfigured("actionDescriptor") },
    grantDigest: recomputeGrantDigest(principal), safetyFloorDigest: notConfigured("safetyFloor"), inputs: [],
    preparationEvidence, bounds: [], completeness: { attempted: 1, completed: 1, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: recordIntentDigest(intent) },
    reconciliations: [], planningWarnings: [], mutations: [recordPageMutation(intent)],
    run: { actor: principal, declaredCompensatorIndexes: [], controlTransitionAllowance: DEFAULT_OPERATION_CONTROL_TRANSITION_ALLOWANCE } };
  return { draft, payloads };
}
