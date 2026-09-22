/**
 * @file src/capability-providers/brokers/receipts.ts
 * @description Host-only construction and canonical digesting of immutable
 * Provider V2 external-effect receipts. Provider requests never parse this
 * shape and cannot supply or amend an authoritative receipt.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import {
  parseBrokerId, parseEffectId, parseInvocationId, parseSemanticVersion,
  parseSha256Digest,
} from "../ids.js";
import type {
  BrokerIdV1, EffectIdV1, InvocationIdV1, SemanticVersionV1, Sha256Digest,
} from "../types.js";
import type { ProviderRollbackSemanticsV1 } from "../authority/types.js";

const EXTERNAL_EFFECT_OUTCOMES = Object.freeze([
  "applied", "already-applied", "refused", "failed", "unavailable", "outcome-unknown",
] as const);
export type ExternalEffectOutcomeV1 = (typeof EXTERNAL_EFFECT_OUTCOMES)[number];

/** Immutable receipt authored only from host-observed broker facts. */
export interface ExternalEffectReceiptV1 {
  readonly schemaVersion: 1;
  readonly effectId: EffectIdV1;
  readonly invocationId: InvocationIdV1;
  readonly providerPinDigest: Sha256Digest;
  readonly grantSnapshotDigest: Sha256Digest;
  readonly effectPlanEntryDigest: Sha256Digest;
  readonly brokerId: BrokerIdV1;
  readonly brokerContractVersion: SemanticVersionV1;
  readonly effectClass: string;
  readonly targetIdentity: string;
  readonly requestDigest: Sha256Digest;
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: ExternalEffectOutcomeV1;
  readonly observedExternalIdentity?: string;
  readonly responseDigest?: Sha256Digest;
  readonly rollbackSemantics: ProviderRollbackSemanticsV1;
  readonly sensitiveFieldsOmitted: true;
}

/** Host facts required before one authoritative receipt can be minted. */
export interface ExternalEffectReceiptInputV1
  extends Omit<ExternalEffectReceiptV1, "schemaVersion" | "sensitiveFieldsOmitted"> {
  readonly approvedRequestDigest: Sha256Digest;
}

const REQUIRED_INPUT_KEYS = Object.freeze([
  "effectId", "invocationId", "providerPinDigest", "grantSnapshotDigest",
  "effectPlanEntryDigest", "brokerId", "brokerContractVersion", "effectClass",
  "targetIdentity", "requestDigest", "approvedRequestDigest", "idempotencyKey",
  "startedAt", "outcome", "rollbackSemantics",
] as const);
const OPTIONAL_INPUT_KEYS = Object.freeze([
  "completedAt", "observedExternalIdentity", "responseDigest",
] as const);

/** Derive the non-caller-authorable effect identity for one broker request. */
export function deriveExternalEffectId(
  preparationRunId: string,
  invocationId: string,
  brokerRequestIndex: number,
): EffectIdV1 {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(preparationRunId)
    || !Number.isSafeInteger(brokerRequestIndex) || brokerRequestIndex < 0) throw receiptError();
  const safeInvocationId = parseInvocationId(invocationId);
  const digest = canonicalDigest({
    domain: "llmwiki-provider-effect-id-v1", preparationRunId,
    invocationId: safeInvocationId, brokerRequestIndex,
  });
  return parseEffectId(`effect-${digest.slice("sha256:".length)}`);
}

/** Mint and freeze one exact receipt after the approved request digest matches. */
export function mintExternalEffectReceipt(
  input: ExternalEffectReceiptInputV1,
): ExternalEffectReceiptV1 {
  try {
    const value = captureReceiptInput(input);
    const requestDigest = parseSha256Digest(value.requestDigest);
    if (requestDigest !== parseSha256Digest(value.approvedRequestDigest)) throw receiptError();
    const startedAt = timestamp(value.startedAt);
    const completedAt = optionalTimestamp(value.completedAt);
    if (completedAt !== undefined && completedAt < startedAt) throw receiptError();
    return Object.freeze({
      schemaVersion: 1,
      effectId: parseEffectId(value.effectId),
      invocationId: parseInvocationId(value.invocationId),
      providerPinDigest: parseSha256Digest(value.providerPinDigest),
      grantSnapshotDigest: parseSha256Digest(value.grantSnapshotDigest),
      effectPlanEntryDigest: parseSha256Digest(value.effectPlanEntryDigest),
      brokerId: parseBrokerId(value.brokerId),
      brokerContractVersion: parseSemanticVersion(value.brokerContractVersion),
      effectClass: token(value.effectClass),
      targetIdentity: boundedText(value.targetIdentity),
      requestDigest,
      idempotencyKey: token(value.idempotencyKey),
      startedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
      outcome: outcome(value.outcome),
      ...optionalTextField("observedExternalIdentity", value.observedExternalIdentity),
      ...(value.responseDigest === undefined ? {} : {
        responseDigest: parseSha256Digest(value.responseDigest),
      }),
      rollbackSemantics: rollback(value.rollbackSemantics),
      sensitiveFieldsOmitted: true,
    });
  } catch { throw receiptError(); }
}

/** Canonically bind one host receipt for later immutable evidence custody. */
export function externalEffectReceiptDigest(receipt: ExternalEffectReceiptV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest(captureReceipt(receipt)));
}

/** Re-validate an externally supplied receipt back into an exact frozen record. */
export function captureExternalEffectReceipt(value: unknown): ExternalEffectReceiptV1 {
  return captureReceipt(value);
}

function captureReceiptInput(value: unknown): Readonly<Record<string, unknown>> {
  const captured = captureOwnDataRecord(value);
  const keys = Object.keys(captured);
  if (REQUIRED_INPUT_KEYS.some((key) => !keys.includes(key))) throw receiptError();
  const allowed = new Set([...REQUIRED_INPUT_KEYS, ...OPTIONAL_INPUT_KEYS]);
  if (keys.some((key) => !allowed.has(key as never))) throw receiptError();
  return captured;
}

function captureReceipt(receipt: unknown): ExternalEffectReceiptV1 {
  const value = captureOwnDataRecord(receipt);
  if (value.schemaVersion !== 1 || value.sensitiveFieldsOmitted !== true) throw receiptError();
  const { schemaVersion: _schema, sensitiveFieldsOmitted: _omitted, ...input } = value;
  return mintExternalEffectReceipt({ ...input, approvedRequestDigest: input.requestDigest } as never);
}

function optionalTextField(key: string, value: unknown): Record<string, string> {
  return value === undefined ? {} : { [key]: boundedText(value) };
}
function optionalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : timestamp(value);
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw receiptError();
  return value;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw receiptError();
  }
  return value;
}
function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)
    || Buffer.byteLength(value) > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) throw receiptError();
  return value;
}
function outcome(value: unknown): ExternalEffectOutcomeV1 {
  if (!EXTERNAL_EFFECT_OUTCOMES.includes(value as ExternalEffectOutcomeV1)) throw receiptError();
  return value as ExternalEffectOutcomeV1;
}
function rollback(value: unknown): ProviderRollbackSemanticsV1 {
  if (value !== "none" && value !== "broker-reversible" && value !== "follow-up-effect-only") {
    throw receiptError();
  }
  return value;
}
function receiptError(): Error { return new Error("provider effect receipt is invalid"); }
