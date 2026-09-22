/**
 * @file src/capability-providers/runtime/result-admission.ts
 * @description Admit one terminal provider result from host-observed custody
 * and protocol facts. Provider-reported counts and artifact claims are untrusted
 * evidence: any claim that contradicts what custody accepted is output-invalid,
 * a missing required output is a typed partial rather than silent success, and
 * custody exhaustion fails the whole result with zero promoted artifacts.
 */
import type { Sha256Digest } from "../types.js";
import { neutralisedProviderText, quotedProviderToken } from "./untrusted-text.js";
import type { ProviderProblemCodeV1 } from "../problems.js";
import type { ExternalEffectReceiptV1 } from "../brokers/receipts.js";
import { parseSha256Digest } from "../ids.js";
import type { RuntimeJsonObjectV1, RuntimeJsonValueV1 } from "./types.js";

/**
 * A durable, host-owned reference to accepted output bytes copied out of the
 * invocation namespace. It survives backend termination so a downstream
 * consumer can read the artifact after the provider process is gone (F1).
 */
export interface EvidenceRefV1 {
  readonly evidencePath: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
}

/** One host-observed artifact that passed custody. */
export interface AcceptedArtifactV1 {
  readonly outputId: string;
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
  readonly evidence?: EvidenceRefV1;
}

/** Result-level custody outcome; exhaustion and rejection promote nothing (D6.4). */
export type CustodyOutcomeV1 =
  | { readonly kind: "accepted"; readonly artifacts: readonly AcceptedArtifactV1[]; readonly scanBytes: number }
  | { readonly kind: "exhausted"; readonly dimension: "custodyScanBytes" | "custodyWallTimeMs" }
  | { readonly kind: "rejected"; readonly reason: string };

/** One declared capability artifact-output disposition. */
export interface DeclaredArtifactOutputV1 {
  readonly outputId: string;
  readonly required: boolean;
  readonly mediaType: string;
}

/** Host-derived completeness counts; never copied from provider counters. */
export interface HostDerivedCountsV1 {
  readonly declared: number;
  readonly acceptedArtifacts: number;
  readonly requiredMissing: number;
  readonly receipts: number;
}

/** Structurally separated untrusted provider evidence, marked as such. */
export interface UntrustedProviderReportV1 {
  readonly untrusted: true;
  readonly providerReportedCounts: RuntimeJsonValueV1;
  readonly warnings: RuntimeJsonValueV1;
  readonly output: RuntimeJsonValueV1;
}

/**
 * Host-observed invocation usage the runtime actually counted. `brokerRequestCount`
 * includes read-only broker calls (HTTPS/model), so it is NOT the effect-receipt
 * count. Token and host-priced cost come from the invocation's own broker meter,
 * which is the only place billable model work can be performed. A dimension the
 * host could not read is surfaced as the explicit sentinel `"unobserved"` — never
 * a fabricated zero.
 */
export interface ProviderObservedUsageV1 {
  readonly brokerRequestCount: number;
  readonly tokenCount: number | "unobserved";
  readonly costMicros: number | "unobserved";
}

/** Inputs for admitting one terminal provider result. */
export interface ResultAdmissionInputV1 {
  readonly providerResult: RuntimeJsonObjectV1;
  readonly custody: CustodyOutcomeV1;
  readonly declaredOutputs: readonly DeclaredArtifactOutputV1[];
  readonly receipts: readonly ExternalEffectReceiptV1[];
  readonly usage: ProviderObservedUsageV1;
}

/** Closed admitted-result outcome; failures keep already-minted receipts. */
export type AdmittedProviderResultV1 =
  | {
      readonly outcome: "succeeded" | "succeeded-with-warnings";
      readonly acceptedArtifacts: readonly AcceptedArtifactV1[];
      readonly counts: HostDerivedCountsV1;
      readonly receipts: readonly ExternalEffectReceiptV1[];
      readonly usage: ProviderObservedUsageV1;
      readonly untrusted: UntrustedProviderReportV1;
    }
  | {
      readonly outcome: "failed" | "partial";
      readonly problem: ProviderProblemCodeV1;
      readonly detail: string;
      readonly receipts: readonly ExternalEffectReceiptV1[];
      readonly usage: ProviderObservedUsageV1;
      readonly untrusted: UntrustedProviderReportV1;
    };

interface ArtifactClaimV1 {
  readonly outputId: string;
  readonly claimedDigest: Sha256Digest;
  readonly claimedByteCount: number;
}

/** Admit or reject one terminal provider result from host-observed facts. */
export function admitProviderResult(input: ResultAdmissionInputV1): AdmittedProviderResultV1 {
  const untrusted = untrustedReport(input.providerResult);
  const usage = input.usage;
  if (input.custody.kind === "exhausted") {
    return failure("provider-resource-exhausted",
      `custody exhausted ${input.custody.dimension}; no artifact promoted`, input.receipts, usage, untrusted);
  }
  if (input.custody.kind === "rejected") {
    return failure("provider-output-invalid", input.custody.reason, input.receipts, usage, untrusted);
  }
  const accepted = input.custody.artifacts;
  const byId = new Map(accepted.map((artifact) => [artifact.outputId, artifact] as const));
  const claimError = validateClaims(input.providerResult, byId);
  if (claimError) return failure("provider-output-invalid", claimError, input.receipts, usage, untrusted);
  const requiredMissing = input.declaredOutputs.filter((output) => output.required && !byId.has(output.outputId));
  const counts = deriveCounts(input.declaredOutputs, accepted, requiredMissing.length, input.receipts.length);
  if (requiredMissing.length > 0) {
    // The host-derived fact stays the classification. The provider's OWN reported
    // reason is appended, labelled untrusted: without it a compile that failed inside
    // the provider and a toolchain that never ran are the same "missing outputs" line.
    // HOST FACT FIRST, provider fragment LAST, and the fragment bounded in BYTES: the
    // durable leg detail is capped at 512 UTF-8 bytes downstream, so a fragment measured
    // in code units could crowd the host's missing-output fact out of the record.
    const reported = providerReportedFailure(input.providerResult);
    return { outcome: "partial", problem: "provider-partial",
      detail: missingOutputsClause(requiredMissing.map((output) => output.outputId))
        + `${reported === null ? "" : `; provider reported failure (untrusted): ${reported}`}`,
      receipts: freezeReceipts(input.receipts), usage, untrusted };
  }
  return admitSuccess(accepted, counts, input.receipts, usage, untrusted);
}

function admitSuccess(
  accepted: readonly AcceptedArtifactV1[], counts: HostDerivedCountsV1,
  receipts: readonly ExternalEffectReceiptV1[], usage: ProviderObservedUsageV1, untrusted: UntrustedProviderReportV1,
): AdmittedProviderResultV1 {
  const warned = Array.isArray(untrusted.warnings) && untrusted.warnings.length > 0;
  return {
    outcome: warned ? "succeeded-with-warnings" : "succeeded",
    acceptedArtifacts: Object.freeze([...accepted]),
    counts, receipts: freezeReceipts(receipts), usage, untrusted,
  };
}

/** Every provider artifact claim must match one custody-accepted artifact exactly. */
function validateClaims(
  providerResult: RuntimeJsonObjectV1, accepted: ReadonlyMap<string, AcceptedArtifactV1>,
): string | null {
  const claims = readClaims(providerResult.artifactClaims);
  if (claims === null) return "provider artifact claims are malformed";
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.outputId)) return `duplicate artifact claim for ${quotedProviderToken(claim.outputId)}`;
    seen.add(claim.outputId);
    const match = accepted.get(claim.outputId);
    if (!match) return `claimed output ${quotedProviderToken(claim.outputId)} was not accepted by custody`;
    if (match.digest !== claim.claimedDigest || match.byteCount !== claim.claimedByteCount) {
      return `claimed digest or size for ${quotedProviderToken(claim.outputId)} contradicts custody`;
    }
  }
  return null;
}

function readClaims(value: RuntimeJsonValueV1 | undefined): ArtifactClaimV1[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const claims: ArtifactClaimV1[] = [];
  for (const entry of value) {
    const claim = readOneClaim(entry);
    if (claim === null) return null;
    claims.push(claim);
  }
  return claims;
}

function readOneClaim(entry: RuntimeJsonValueV1): ArtifactClaimV1 | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as RuntimeJsonObjectV1;
  const outputId = record.outputId;
  const claimedByteCount = record.claimedByteCount;
  if (typeof outputId !== "string" || outputId.length === 0
    || !Number.isSafeInteger(claimedByteCount) || (claimedByteCount as number) < 0) return null;
  try {
    return Object.freeze({
      outputId, claimedDigest: parseSha256Digest(record.claimedDigest),
      claimedByteCount: claimedByteCount as number,
    });
  } catch { return null; }
}

function deriveCounts(
  declared: readonly DeclaredArtifactOutputV1[], accepted: readonly AcceptedArtifactV1[],
  requiredMissing: number, receipts: number,
): HostDerivedCountsV1 {
  return Object.freeze({
    declared: declared.length, acceptedArtifacts: accepted.length, requiredMissing, receipts,
  });
}

/**
 * The most provider-reported failure text carried into a host detail line, in UTF-8
 * BYTES: the composed detail must still fit the durable 512-byte leg cap with the
 * host's own clause intact, and a multibyte reason measured in code units would not.
 */
const MAX_REPORTED_FAILURE_BYTES = 256;

/**
 * The provider's own failure reason when its terminal result says `outcome: "failed"`
 * with a string `detail` — UNTRUSTED text, neutralised to one printable line and
 * bounded, carried only so the operator can read what the provider saw. It never
 * changes the host's classification.
 */
function providerReportedFailure(providerResult: RuntimeJsonObjectV1): string | null {
  if (providerResult.outcome !== "failed" || typeof providerResult.detail !== "string") return null;
  const detail = neutralisedProviderText(providerResult.detail, MAX_REPORTED_FAILURE_BYTES);
  return detail.length === 0 ? null : detail;
}

/**
 * The host's own missing-output fact, bounded in BYTES too: a manifest may declare
 * 128 outputs of 128-byte ids, so the bare list could reach ~16 KB and the durable
 * 512-byte cap would then cut HOST text. The COUNT is always stated; ids are listed
 * until the budget is spent and the remainder is counted, so the fact survives whole.
 */
const MAX_MISSING_OUTPUT_IDS_BYTES = 160;
function missingOutputsClause(outputIds: readonly string[]): string {
  const listed: string[] = [];
  let bytes = 0;
  for (const outputId of outputIds) {
    const cost = Buffer.byteLength(outputId, "utf8") + (listed.length === 0 ? 0 : 2);
    if (bytes + cost > MAX_MISSING_OUTPUT_IDS_BYTES) break;
    listed.push(outputId);
    bytes += cost;
  }
  const omitted = outputIds.length - listed.length;
  const tail = omitted > 0 ? `${listed.length === 0 ? "" : ", "}+${omitted} more` : "";
  return `missing required outputs (${outputIds.length}): ${listed.join(", ")}${tail}`;
}

function untrustedReport(providerResult: RuntimeJsonObjectV1): UntrustedProviderReportV1 {
  return Object.freeze({
    untrusted: true,
    providerReportedCounts: providerResult.providerReportedCounts ?? null,
    warnings: providerResult.warnings ?? null,
    output: providerResult.output ?? null,
  });
}

function failure(
  problem: ProviderProblemCodeV1, detail: string, receipts: readonly ExternalEffectReceiptV1[],
  usage: ProviderObservedUsageV1, untrusted: UntrustedProviderReportV1,
): AdmittedProviderResultV1 {
  return { outcome: "failed", problem, detail, receipts: freezeReceipts(receipts), usage, untrusted };
}

function freezeReceipts(receipts: readonly ExternalEffectReceiptV1[]): readonly ExternalEffectReceiptV1[] {
  return Object.freeze([...receipts]);
}
