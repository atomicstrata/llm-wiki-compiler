/**
 * @file src/capability-providers/brokers/dispatch-outcome.ts
 * @description Pure provider-visible result shaping for the broker dispatcher:
 * host-observed execution outcomes are mapped to dispatch statuses and receipts,
 * partial results are kept distinct, credential reflection is scanned, and a
 * post-deadline request is shaped without any external contact.
 */
import { assertNoCredentialReflection } from "../authority/credentials.js";
import { matchEffectPlanEntry } from "../authority/effect-plan.js";
import type { EffectiveProviderGrantV1 } from "../authority/types.js";
import { MAX_PROTOCOL_FRAME_BYTES } from "../constants.js";
import type { InvocationIdV1 } from "../types.js";
import {
  mintExternalEffectReceipt, type ExternalEffectOutcomeV1, type ExternalEffectReceiptV1,
} from "./receipts.js";
import type {
  BrokerDispatchResultV1, BrokerJsonObjectV1, BrokerRequestEnvelopeV1,
  HostBrokerExecutionV1,
} from "./types.js";

/** Build the frozen provider-visible dispatch result from a host execution. */
export function buildDispatchResult(
  envelope: BrokerRequestEnvelopeV1, execution: HostBrokerExecutionV1,
  receipt: ExternalEffectReceiptV1 | null, refused: boolean,
): BrokerDispatchResultV1 {
  const status = refused ? "refused" : statusFor(execution.outcome);
  const output: BrokerJsonObjectV1 | null = refused
    ? Object.freeze({ reason: "broker output was refused" }) : execution.output;
  const completion = status === "partial" && execution.completion
    ? execution.completion : null;
  return Object.freeze({
    schemaVersion: 1, requestId: envelope.requestId, brokerId: envelope.brokerId,
    status, output, receipt, completion,
  });
}

/**
 * A broker request that arrives after the host wall-time deadline is refused
 * before any external contact when it is mutating, and reported unavailable
 * when it is read-only. Neither path transmits or mints a receipt.
 */
export function deadlineExceededResult(
  envelope: BrokerRequestEnvelopeV1, mutating: boolean,
): BrokerDispatchResultV1 {
  return Object.freeze({
    schemaVersion: 1, requestId: envelope.requestId, brokerId: envelope.brokerId,
    status: mutating ? "refused" : "unavailable",
    output: Object.freeze({ reason: mutating
      ? "mutating effect refused after the invocation wall-time deadline before transmission"
      : "read-only broker unavailable after the invocation wall-time deadline" }),
    receipt: null, completion: null,
  });
}

/** Host fallback when a broker adapter throws instead of returning a result. */
export function fallbackExecution(mutating: boolean): HostBrokerExecutionV1 {
  const outcome = mutating ? "outcome-unknown" : "unavailable";
  return Object.freeze({ outcome, output: Object.freeze({ reason: "broker execution is unavailable" }) });
}

/** True when an injected credential appears in any provider-visible surface. */
export function credentialReflected(secret: Buffer | null, execution: HostBrokerExecutionV1): boolean {
  if (!secret) return false;
  try { assertVisibleSurfaces(secret, execution); return false; }
  catch { return true; }
}

/** Mint one authoritative receipt from host-observed broker facts. */
export function receiptFor(
  invocationId: InvocationIdV1, envelope: BrokerRequestEnvelopeV1,
  grant: EffectiveProviderGrantV1,
  matched: ReturnType<typeof matchEffectPlanEntry>, execution: HostBrokerExecutionV1,
  startedAt: string, completedAt: string | undefined, omitOptionalEvidence: boolean,
): ExternalEffectReceiptV1 {
  const outcome = effectOutcome(execution.outcome);
  return mintExternalEffectReceipt({
    effectId: matched.entry.effectId, invocationId,
    providerPinDigest: grant.providerPinDigest, grantSnapshotDigest: grant.grantSnapshotDigest,
    effectPlanEntryDigest: matched.entryDigest, brokerId: envelope.brokerId,
    brokerContractVersion: envelope.brokerContractVersion,
    effectClass: matched.entry.effectClass, targetIdentity: matched.entry.targetIdentity,
    requestDigest: matched.entry.requestDigest, approvedRequestDigest: matched.entry.requestDigest,
    idempotencyKey: matched.entry.idempotencyKey, startedAt,
    ...(completedAt === undefined ? {} : { completedAt }), outcome,
    ...(!omitOptionalEvidence && execution.observedExternalIdentity ? {
      observedExternalIdentity: execution.observedExternalIdentity,
    } : {}),
    ...(!omitOptionalEvidence && execution.responseDigest ? {
      responseDigest: execution.responseDigest,
    } : {}),
    rollbackSemantics: matched.entry.rollbackSemantics,
  });
}

/**
 * Keep a partial result distinct from ok and failed. A mutating effect can
 * never be partial, so a matched partial settles as outcome-unknown; a
 * read-only partial without bounded host completion evidence is untrusted and
 * degrades to unavailable rather than a silent success.
 */
export function finalizePartial(
  execution: HostBrokerExecutionV1, mutating: boolean,
): HostBrokerExecutionV1 {
  if (execution.outcome !== "partial") return execution;
  const { completion: _completion, ...rest } = execution;
  if (mutating) {
    return Object.freeze({ ...rest, outcome: "outcome-unknown",
      output: Object.freeze({ reason: "mutating broker returned a non-terminal partial result" }) });
  }
  if (!validCompletion(execution.completion)) {
    return Object.freeze({ ...rest, outcome: "unavailable",
      output: Object.freeze({ reason: "partial broker result is missing host completion evidence" }) });
  }
  return execution;
}

/**
 * Refuse any provider-visible result whose serialized frame would exceed the
 * protocol frame budget. Large bytes never ride inline in a broker response;
 * the result is refused with a typed bounds problem naming the dimension rather
 * than truncated or silently inlined. Host-only visibleBytes stay structurally
 * separate for Task 7 descriptor/token custody.
 */
export function enforceInlineResponseCeiling(
  result: BrokerDispatchResultV1,
): BrokerDispatchResultV1 {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_PROTOCOL_FRAME_BYTES) return result;
  return Object.freeze({
    ...result, status: "refused",
    output: Object.freeze({
      reason: "broker response exceeds the protocol frame budget",
      dimension: "protocolBytes",
    }),
  });
}

/** Map a host execution outcome to a provider-visible dispatch status. */
export function statusFor(outcome: HostBrokerExecutionV1["outcome"]): BrokerDispatchResultV1["status"] {
  if (outcome === "ok" || outcome === "applied" || outcome === "already-applied") return "ok";
  return outcome;
}

function validCompletion(completion: HostBrokerExecutionV1["completion"]): boolean {
  return completion !== undefined
    && Number.isSafeInteger(completion.completed) && completion.completed >= 0
    && Number.isSafeInteger(completion.attempted) && completion.attempted >= 0
    && completion.completed <= completion.attempted;
}

function effectOutcome(outcome: HostBrokerExecutionV1["outcome"]): ExternalEffectOutcomeV1 {
  if (outcome === "ok") return "failed";
  if (outcome === "partial") return "outcome-unknown";
  return outcome;
}

function assertVisibleSurfaces(secret: Buffer, execution: HostBrokerExecutionV1): void {
  const output = execution.output === null ? [] : [Buffer.from(JSON.stringify(execution.output))];
  assertNoCredentialReflection([secret], {
    urls: [], headers: [], errors: [], status: [],
    frames: Object.freeze([...output, ...(execution.visibleBytes ?? [])]),
    stdout: [], stderr: [],
    receipts: execution.observedExternalIdentity ? [execution.observedExternalIdentity] : [],
    retainedEvidence: [],
  });
}
