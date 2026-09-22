/**
 * @file src/preparations/attempts/admit-result.ts
 * @description Leg H — project one bounded provider or host-handler leg result
 * onto the attempt surface AND copy its output bytes into a bounded TEMPORARY
 * custody directory while the project lock is released (design sections 16.2,
 * 15.4; Global Constraint "providers and host handlers produce evidence only").
 * Authoritative publication into the preparation evidence CAS happens later,
 * UNDER THE LOCK, at commit. Provider prose, self-reported counts, and artifact
 * claims never cross this seam. An output whose bytes cannot be copied and
 * re-hashed within the sealed ceiling fails the phase closed with nothing
 * custodied, and temporary custody is discarded on EVERY failing path — including
 * a thrown one — so a rejected result never strands host-owned bytes.
 */

import path from "node:path";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import type {
  AdmittedProviderResultV1, AcceptedArtifactV1, ProviderObservedUsageV1,
} from "../../capability-providers/runtime/result-admission.js";
import type { ProviderInvocationResultV1 } from "../../capability-providers/runtime/invoke.js";
import type { ExternalEffectReceiptV1 } from "../../capability-providers/brokers/receipts.js";
import { copyIntoCustody, createCustodyDir, discardCustody } from "./custody.js";
import type { EvidenceRefV1, Sha256Digest } from "../types.js";
import type {
  AttemptEffectObservationV1, AttemptLegOutcomeV1, AttemptSettledPhaseState,
  HostHandlerOutputV1, HostHandlerResultV1, PendingEvidenceV1, PreparationProviderContextV1,
} from "./types.js";

const SHA256_PREFIX = "sha256:";
const HOST_OUTPUT_CONTRACT = parseSha256Digest(canonicalDigest({ domain: "llmwiki-preparation-host-output-v1" }));

/** Emit an optional field only when defined. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** Map admitted provider outcomes to a host-derived settled phase state. */
function providerPhaseState(admitted: AdmittedProviderResultV1): AttemptSettledPhaseState {
  if (admitted.outcome === "succeeded") return "succeeded";
  if (admitted.outcome === "succeeded-with-warnings") return "succeeded-with-warnings";
  return "failed";
}

/** The preparation-owned metadata for one recustodied provider output. */
function providerEvidenceRef(artifact: AcceptedArtifactV1, context: PreparationProviderContextV1): EvidenceRefV1 {
  return {
    kind: "provider-output", mediaType: artifact.mediaType, provenanceLabel: artifact.outputId,
    digest: artifact.digest, byteCount: artifact.byteCount, sensitivity: "ordinary", retention: "audit",
    producer: { kind: "provider", providerPinDigest: context.providerPinDigest, attemptId: context.attemptId },
    untrusted: true,
  };
}

/** The preparation-owned metadata for one recustodied host-handler output. */
function hostEvidenceRef(output: HostHandlerOutputV1): EvidenceRefV1 {
  return {
    kind: "host-output", mediaType: output.mediaType, provenanceLabel: output.provenanceLabel,
    digest: output.digest, byteCount: output.byteCount, sensitivity: "ordinary", retention: "audit",
    producer: { kind: "host", contractDigest: HOST_OUTPUT_CONTRACT }, untrusted: true,
  };
}

/** One output object to copy into temporary custody: its source path and ref. */
interface OutputToCustody { sourcePath: string; ref: EvidenceRefV1 }

/**
 * Copy ONE output into the shared custody directory, REUSING the object an
 * earlier output of the same batch already custodied under that digest. Custody
 * is content-addressed, so two accepted artifacts carrying identical bytes are
 * one object referenced by two refs — exactly what the create-only evidence CAS
 * itself does at publication. Reuse is admitted only when the earlier copy's
 * verified length equals this ref's claimed length; anything else fails closed.
 */
async function custodyOneOutput(
  output: OutputToCustody, tempDir: string, cap: number, copiedByDigest: Map<string, number>,
): Promise<PendingEvidenceV1 | null> {
  const bare = output.ref.digest.slice(SHA256_PREFIX.length);
  const already = copiedByDigest.get(bare);
  const copied = already ?? await copyIntoCustody(output.sourcePath, tempDir, bare, cap);
  if (copied === null || copied !== output.ref.byteCount) return null;
  copiedByDigest.set(bare, copied);
  return { ref: output.ref, tempPath: path.join(tempDir, bare) };
}

/** Copy every output into `tempDir`, or null when any one fails closed. */
async function copyOutputsInto(
  outputs: readonly OutputToCustody[], tempDir: string, cap: number,
): Promise<PendingEvidenceV1[] | null> {
  const pending: PendingEvidenceV1[] = [];
  const copiedByDigest = new Map<string, number>();
  for (const output of outputs) {
    const item = await custodyOneOutput(output, tempDir, cap, copiedByDigest);
    if (item === null) return null;
    pending.push(item);
  }
  return pending;
}

/**
 * Copy every output into a fresh temp custody dir; null (discarding) on any
 * fault. The discard is UNCONDITIONAL: a thrown fault discards the directory and
 * rethrows, so no path — including one that leaves the leg through a fault the
 * executor maps to `recovery-required` — can strand temporary custody bytes.
 */
async function custodyOutputs(
  outputs: readonly OutputToCustody[], cap: number,
): Promise<{ tempDir?: string; pending: PendingEvidenceV1[] } | null> {
  if (outputs.length === 0) return { pending: [] };
  const tempDir = await createCustodyDir();
  let pending: PendingEvidenceV1[] | null;
  try {
    pending = await copyOutputsInto(outputs, tempDir, cap);
  } catch (error) {
    await discardCustody(tempDir);
    throw error;
  }
  if (pending !== null) return { tempDir, pending };
  await discardCustody(tempDir);
  return null;
}

/** Project host-minted receipts as ordered attempt effect observations. */
function receiptObservations(receipts: readonly ExternalEffectReceiptV1[]): readonly AttemptEffectObservationV1[] {
  return receipts.map((receipt, effectIndex) => ({ receipt, effectIndex }));
}

/** The observed grant snapshot, if any receipt recorded one. */
function observedGrant(receipts: readonly ExternalEffectReceiptV1[]): Sha256Digest | undefined {
  return receipts[0]?.grantSnapshotDigest;
}

/** The spend a failed leg carries; absent measurement stays the honest sentinel. */
interface LegUsageV1 {
  readonly brokerRequestCount: number;
  readonly tokenCount: number | "unobserved";
  readonly costMicros: number | "unobserved";
}

const UNOBSERVED_LEG_USAGE: LegUsageV1 = Object.freeze({
  brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved",
});

/**
 * Project the usage a failed invocation already observed onto the leg surface.
 * A failure raised before the broker dispatcher existed has no measurement and
 * keeps the sentinel; one raised after it carries the real meter reading, so
 * spend is not lost precisely where an attempt may be retried. A phase with no
 * model adapter cannot consume tokens or cost at all, so those stay a structural
 * 0 exactly as on the success path.
 */
function failedLegUsage(
  usage: ProviderObservedUsageV1 | undefined, tokenApplicable: boolean,
): LegUsageV1 {
  if (usage === undefined) return tokenApplicable ? UNOBSERVED_LEG_USAGE : { ...UNOBSERVED_LEG_USAGE, tokenCount: 0, costMicros: 0 };
  return {
    brokerRequestCount: usage.brokerRequestCount,
    tokenCount: tokenApplicable ? usage.tokenCount : 0,
    costMicros: tokenApplicable ? usage.costMicros : 0,
  };
}

/**
 * The writer-side cap on a failure detail. The parser refuses over-long strings,
 * so an unbounded detail persisted today would make the run record UNREADABLE
 * tomorrow — the bound has to hold where the bytes are written, not only where
 * they are read back.
 */
const MAX_PROBLEM_DETAIL_BYTES = 512;
/** `…` is three UTF-8 bytes; the cap must hold with it appended. */
const ELLIPSIS_BYTES = Buffer.byteLength("…", "utf8");

/** Truncate a host-authored detail to the durable cap, preserving valid UTF-8. */
function boundedDetail(detail: string | undefined): string | undefined {
  if (detail === undefined || detail.length === 0) return undefined;
  if (Buffer.byteLength(detail, "utf8") <= MAX_PROBLEM_DETAIL_BYTES) return detail;
  // Reserve the ellipsis's REAL encoded length (3 bytes), not one: a multibyte detail
  // cut at cap-1 plus "…" persisted 514 bytes against a stated 512-byte bound.
  return `${Buffer.from(detail, "utf8").subarray(0, MAX_PROBLEM_DETAIL_BYTES - ELLIPSIS_BYTES).toString("utf8").replace(/\uFFFD+$/, "")}…`;
}

/** A failed leg outcome carrying an optional observed pin and a fixed problem. */
function legFailure(
  problem: string, observedProviderPinDigest?: Sha256Digest, usage: LegUsageV1 = UNOBSERVED_LEG_USAGE,
  problemDetail?: string,
): AttemptLegOutcomeV1 {
  const detail = boundedDetail(problemDetail);
  return {
    phaseState: "failed", pendingEvidence: [], effects: [], invocationCount: 1,
    brokerRequestCount: usage.brokerRequestCount,
    tokenCount: usage.tokenCount, costMicros: usage.costMicros,
    ...(observedProviderPinDigest === undefined ? {} : { observedProviderPinDigest }), problem,
    ...(detail === undefined ? {} : { problemDetail: detail }),
  };
}

/** Map one accepted artifact to its custody source, or null when it has no bytes. */
function providerOutput(artifact: AcceptedArtifactV1, context: PreparationProviderContextV1): OutputToCustody | null {
  return artifact.evidence === undefined
    ? null : { sourcePath: artifact.evidence.evidencePath, ref: providerEvidenceRef(artifact, context) };
}

/** Project a completed provider admission, copying its artifacts into custody. */
async function admitCompletedProvider(
  admitted: AdmittedProviderResultV1, context: PreparationProviderContextV1, cap: number, tokenApplicable: boolean,
): Promise<AttemptLegOutcomeV1> {
  const isSuccess = admitted.outcome === "succeeded" || admitted.outcome === "succeeded-with-warnings";
  const toCustody = (isSuccess ? admitted.acceptedArtifacts : []).map((artifact) => providerOutput(artifact, context));
  // A recustody failure discards the OUTPUT, never the spend already metered to
  // produce it; the admitted result's usage survives onto the failed leg.
  const spent = failedLegUsage(admitted.usage, tokenApplicable);
  if (toCustody.includes(null)) return legFailure("provider-output-recustody-failed", context.providerPinDigest, spent);
  const custody = await custodyOutputs(toCustody as OutputToCustody[], cap);
  if (custody === null) return legFailure("provider-output-recustody-failed", context.providerPinDigest, spent);
  const outputDigest = isSuccess ? admitted.acceptedArtifacts[0]?.digest : undefined;
  return assembleProviderOutcome(admitted, context, custody, outputDigest, tokenApplicable);
}

/** Assemble the completed provider leg outcome from its host-observed facts. */
function assembleProviderOutcome(
  admitted: AdmittedProviderResultV1, context: PreparationProviderContextV1,
  custody: { tempDir?: string; pending: PendingEvidenceV1[] }, outputEvidenceDigest: Sha256Digest | undefined,
  tokenApplicable: boolean,
): AttemptLegOutcomeV1 {
  // CARRIED, not dropped: the admitted detail is the only durable record of WHY a
  // partial/failed leg failed (the failed-invocation path already threads it; this
  // completed-but-partial path did not, so every diagnostic printed `detail=?`).
  const failed = admitted.outcome === "failed" || admitted.outcome === "partial" ? admitted : undefined;
  const problem = failed?.problem;
  const problemDetail = failed === undefined ? undefined : boundedDetail(failed.detail);
  return {
    phaseState: providerPhaseState(admitted), pendingEvidence: custody.pending,
    effects: receiptObservations(admitted.receipts), invocationCount: 1,
    // Measure the REAL host-observed broker usage, not the effect-receipt count.
    brokerRequestCount: admitted.usage.brokerRequestCount,
    // With a model adapter the dimension is applicable and carries the runtime's
    // metered host-priced observation (or its `"unobserved"` sentinel, which parks).
    // Without one the capability cannot consume tokens/cost at all — a 0 proven
    // structurally from the absent adapter, never the unobserved sentinel.
    tokenCount: tokenApplicable ? admitted.usage.tokenCount : 0,
    costMicros: tokenApplicable ? admitted.usage.costMicros : 0,
    observedProviderPinDigest: context.providerPinDigest,
    ...optional("outputEvidenceDigest", outputEvidenceDigest),
    ...optional("custodyTempDir", custody.tempDir),
    ...optional("observedGrantSnapshotDigest", observedGrant(admitted.receipts)),
    ...optional("problem", problem),
    ...optional("problemDetail", problemDetail),
  };
}

/** Project one terminal provider invocation result onto the attempt surface. */
export async function admitProviderLeg(
  result: ProviderInvocationResultV1, context: PreparationProviderContextV1, cap: number, tokenApplicable: boolean,
): Promise<AttemptLegOutcomeV1> {
  if (result.kind === "failed") {
    // The detail travels WITH the code: "provider-grant-missing" alone sent an
    // operator into the bundle with a debugger; "provider grant store is
    // unavailable" names the store to look at.
    const outcome = legFailure(
      result.problem, context.providerPinDigest, failedLegUsage(result.usage, tokenApplicable),
      result.detail,
    );
    return result.problem === "provider-cancelled" ? { ...outcome, phaseState: "cancelled" } : outcome;
  }
  return admitCompletedProvider(result.admitted, context, cap, tokenApplicable);
}

/** Project one terminal host-handler result onto the attempt surface. */
export async function admitHostHandlerLeg(result: HostHandlerResultV1, cap: number): Promise<AttemptLegOutcomeV1> {
  if (result.kind === "cancelled") {
    return { phaseState: "cancelled", pendingEvidence: [], effects: [], invocationCount: 1, brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" };
  }
  // The handler's own sentence travels with the code — the same rule the
  // provider leg follows, for the same reason: `pack-input-list-length-mismatch`
  // names the class, "the frozen action input's list fields do not agree on
  // length" names the fix.
  if (result.kind === "failed") return legFailure(result.problem, undefined, UNOBSERVED_LEG_USAGE, result.detail);
  const custody = await custodyOutputs(result.outputs.map((output) => ({ sourcePath: output.sourcePath, ref: hostEvidenceRef(output) })), cap);
  if (custody === null) return legFailure("host-output-recustody-failed");
  const receipts = result.receipts ?? [];
  return {
    phaseState: result.succeededWithWarnings ? "succeeded-with-warnings" : "succeeded",
    ...optional("outputEvidenceDigest", result.outputEvidenceDigest),
    pendingEvidence: custody.pending, ...optional("custodyTempDir", custody.tempDir),
    effects: receiptObservations(receipts), invocationCount: 1, brokerRequestCount: receipts.length,
    // Host handlers run locally and do not consume model tokens/cost — a proven 0.
    tokenCount: 0, costMicros: 0,
  };
}
