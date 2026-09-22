/**
 * @file src/capability-providers/brokers/types.ts
 * @description Closed Provider V2 broker envelope and result contracts. The
 * envelope admits only bounded inert JSON; broker-specific modules apply their
 * narrower schemas before any host operation runs.
 */
import { captureDenseArray, captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import { canonicalBytes, canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  parseBrokerId, parseEffectId, parseRequestId, parseSemanticVersion, parseSha256Digest,
} from "../ids.js";
import type {
  BrokerIdV1, EffectIdV1, RequestIdV1, SemanticVersionV1, Sha256Digest,
} from "../types.js";
import type {
  EffectPlanEntryV1, ProviderAuthorityAtomV1, ProviderGrantKindV1,
} from "../authority/types.js";
import { MAX_PROTOCOL_FRAME_BYTES } from "../constants.js";
import type { ExternalEffectOutcomeV1 } from "./receipts.js";
import type { HostInvocationDeadlineV1 } from "./deadline.js";

const ENVELOPE_KEYS = Object.freeze([
  "schemaVersion", "requestId", "brokerId", "brokerContractVersion", "payload", "effect",
] as const);
const MAX_BROKER_PAYLOAD_DEPTH = 16;
const MAX_BROKER_PAYLOAD_MEMBERS = 4_096;
const MAX_BROKER_PAYLOAD_STRING_BYTES = 1_048_576;

/** Registry metadata is host-authored and never supplied by a pack or provider. */
export interface HostBrokerContractV1 {
  readonly brokerId: BrokerIdV1;
  readonly brokerContractVersion: SemanticVersionV1;
  readonly grantKind: ProviderGrantKindV1;
  readonly access: "read-only" | "mutating" | "conditional";
}

/** Exact protocol-side request envelope; receipts have no request field. */
export interface BrokerRequestEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly requestId: RequestIdV1;
  readonly brokerId: BrokerIdV1;
  readonly brokerContractVersion: SemanticVersionV1;
  readonly payload: BrokerJsonObjectV1;
  readonly effect: BrokerJsonObjectV1 | null;
}

/** The provider may select one prepared effect but cannot restate its facts. */
export interface BrokerEffectReferenceV1 { readonly effectId: EffectIdV1 }

/** Invocation-private usage debited from host-observed broker work. */
export interface HostBrokerUsageV1 {
  readonly httpsTransferBytes?: number;
  readonly modelTokens?: number;
  readonly modelCostUsd?: number;
  readonly commandAcceptedBytes?: number;
}

/** Remaining host hard ceilings passed only to reviewed broker code. */
export interface HostBrokerBudgetV1 {
  readonly httpsTransferBytes: number;
  readonly modelTokens: number;
  readonly modelCostUsd: number;
  readonly commandAcceptedBytes: number;
}

/** Canonical mutating facts that must match one immutable effect-plan entry. */
export interface HostBrokerEffectFactsV1 {
  readonly effectClass: string;
  readonly targetIdentity: string;
  readonly requestDigest: Sha256Digest;
  readonly expectedBounds: Readonly<Record<string, number>>;
}

/** Bounded host-observed completion evidence carried only by a partial result. */
export interface BrokerCompletionEvidenceV1 {
  readonly completed: number;
  readonly attempted: number;
}

/** Host-observed execution result; mutating outcomes are receipt outcomes. */
export interface HostBrokerExecutionV1 {
  readonly outcome: "ok" | "partial" | "refused" | "unavailable" | "failed" | ExternalEffectOutcomeV1;
  readonly output: BrokerJsonObjectV1 | null;
  readonly usage?: HostBrokerUsageV1;
  readonly visibleBytes?: readonly Uint8Array[];
  readonly observedExternalIdentity?: string;
  readonly responseDigest?: Sha256Digest;
  readonly usageReserved?: true;
  readonly completion?: BrokerCompletionEvidenceV1;
}

/** Standard host adapter observation for mutating broker post-state. */
export interface HostExternalEffectObservationV1 {
  readonly outcome: ExternalEffectOutcomeV1;
  readonly observedExternalIdentity?: string;
  readonly responseDigest?: Sha256Digest;
  readonly output?: BrokerJsonObjectV1;
}

/**
 * Host-owned execution context handed to every broker adapter. Bundling the
 * meter and deadline seams keeps the execute signature stable and forces each
 * adapter to acknowledge new host fields, so a future capability can never be
 * silently dropped by a shorter positional arity.
 */
export interface HostBrokerExecutionContextV1 {
  readonly budget: HostBrokerBudgetV1;
  readonly reserve: (usage: HostBrokerUsageV1) => boolean;
  readonly settle: (released: HostBrokerUsageV1) => void;
  readonly deadline: HostInvocationDeadlineV1;
}

/** Captured broker request ready for central authority and meter checks. */
export interface PreparedHostBrokerCallV1 {
  readonly authority: readonly ProviderAuthorityAtomV1[];
  readonly credentialSlotId: string | null;
  readonly credentialOperation: string | null;
  readonly category: "https" | "model" | "repository" | "command" | "scheduler" | "email" | "remote-effect";
  readonly effect: HostBrokerEffectFactsV1 | null;
  execute(
    secret: Buffer | null,
    effect: EffectPlanEntryV1 | null,
    context: HostBrokerExecutionContextV1,
  ): Promise<HostBrokerExecutionV1>;
}

/** Provider-visible dispatcher result with no caller-authorable receipt seam. */
export interface BrokerDispatchResultV1 {
  readonly schemaVersion: 1;
  readonly requestId: RequestIdV1;
  readonly brokerId: BrokerIdV1;
  readonly status: "ok" | "partial" | "refused" | "unavailable" | "failed" | "outcome-unknown";
  readonly output: BrokerJsonObjectV1 | null;
  readonly receipt: import("./receipts.js").ExternalEffectReceiptV1 | null;
  readonly completion: BrokerCompletionEvidenceV1 | null;
}

/**
 * Host-only dispatch outcome. `result` is the provider-visible dispatch record;
 * `visibleBytes` are the large, already-secret-scanned response bytes (HTTPS
 * body, repository snapshot, model/command output) the provider never receives
 * inline. Task 7 materializes these into a host-written, guest-read-only
 * broker-response region and hands the provider an opaque token, never a path
 * or the bytes themselves. Empty whenever the response is refused or a
 * credential was reflected.
 */
export interface HostBrokerDispatchV1 {
  readonly result: BrokerDispatchResultV1;
  readonly visibleBytes: readonly Uint8Array[];
}

/** Bounded inert values accepted at the generic envelope boundary. */
export interface BrokerJsonObjectV1 {
  readonly [key: string]: BrokerJsonValueV1;
}
export interface BrokerJsonArrayV1 extends ReadonlyArray<BrokerJsonValueV1> {}
export type BrokerJsonValueV1 =
  | null | boolean | number | string
  | BrokerJsonArrayV1
  | BrokerJsonObjectV1;

interface CaptureBudget { members: number; bytes: number }

/** Capture one exact broker envelope before registry lookup or authority I/O. */
export function parseBrokerRequestEnvelope(value: unknown): BrokerRequestEnvelopeV1 {
  try {
    const envelope = captureExactRecord(value, ENVELOPE_KEYS);
    if (envelope.schemaVersion !== 1) throw brokerRequestError();
    const budget = { members: 0, bytes: envelopeBytes(envelope) };
    const payload = captureBrokerRecord(envelope.payload, 0, budget);
    const effect = envelope.effect === null
      ? null : captureBrokerRecord(envelope.effect, 0, budget);
    const captured = Object.freeze({
      schemaVersion: 1,
      requestId: parseRequestId(envelope.requestId),
      brokerId: parseBrokerId(envelope.brokerId),
      brokerContractVersion: parseSemanticVersion(envelope.brokerContractVersion),
      payload,
      effect,
    });
    if (canonicalBytes(captured).byteLength > MAX_PROTOCOL_FRAME_BYTES) throw brokerRequestError();
    return captured;
  } catch { throw brokerRequestError(); }
}

/** Capture one bounded inert host-adapter output object exactly once. */
export function captureBrokerJsonObject(value: unknown): BrokerJsonObjectV1 {
  try { return captureBrokerRecord(value, 0, { members: 0, bytes: 0 }); }
  catch { throw brokerRequestError(); }
}

/** Construct one sanitized bounded read-only broker failure response. */
export function brokerFailure(
  outcome: "refused" | "unavailable", reason: string, usageReserved = false,
): HostBrokerExecutionV1 {
  return Object.freeze({ outcome, output: Object.freeze({ reason }),
    visibleBytes: Object.freeze([Buffer.from(reason)]),
    ...(usageReserved ? { usageReserved: true as const } : {}) });
}

/** Bind the already-captured broker contract and payload into one request digest. */
export function brokerRequestDigest(
  envelope: BrokerRequestEnvelopeV1,
  resolvedOperationFacts?: BrokerJsonObjectV1,
): Sha256Digest {
  return parseSha256Digest(canonicalDigest({
    domain: "llmwiki-provider-broker-request-v1", brokerId: envelope.brokerId,
    brokerContractVersion: envelope.brokerContractVersion, payload: envelope.payload,
    ...(resolvedOperationFacts === undefined ? {} : { resolvedOperationFacts }),
  }));
}

/** Capture the sole provider-authored effect reference. */
export function parseBrokerEffectReference(value: BrokerJsonObjectV1): BrokerEffectReferenceV1 {
  try {
    const reference = captureExactRecord(value, ["effectId"]);
    return Object.freeze({ effectId: parseEffectId(reference.effectId) });
  } catch { throw brokerRequestError(); }
}

function captureBrokerRecord(
  value: unknown,
  depth: number,
  budget: CaptureBudget,
): BrokerJsonObjectV1 {
  const record = captureOwnDataRecord(value);
  const result = Object.create(null) as Record<string, BrokerJsonValueV1>;
  for (const key of Object.keys(record).sort()) {
    if (!safeKey(key)) throw brokerRequestError();
    debitBytes(budget, Buffer.byteLength(key));
    budget.members += 1;
    if (budget.members > MAX_BROKER_PAYLOAD_MEMBERS) throw brokerRequestError();
    result[key] = captureBrokerValue(record[key], depth + 1, budget);
  }
  return Object.freeze(result);
}

function captureBrokerValue(value: unknown, depth: number, budget: CaptureBudget): BrokerJsonValueV1 {
  if (depth > MAX_BROKER_PAYLOAD_DEPTH) throw brokerRequestError();
  if (value === null || typeof value !== "object") return captureBrokerScalar(value, budget);
  if (Array.isArray(value)) return captureBrokerArray(value, depth, budget);
  return captureBrokerRecord(value, depth, budget);
}

function captureBrokerScalar(value: unknown, budget: CaptureBudget): null | boolean | number | string {
  if (value === null || typeof value === "boolean") {
    debitBytes(budget, value === null ? 4 : value ? 4 : 5); return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    debitBytes(budget, Buffer.byteLength(String(value))); return value;
  }
  if (typeof value === "string") return capturedString(value, budget);
  throw brokerRequestError();
}

function captureBrokerArray(value: unknown, depth: number, budget: CaptureBudget) {
  return captureDenseArray(value, MAX_BROKER_PAYLOAD_MEMBERS, (item) => {
    budget.members += 1;
    if (budget.members > MAX_BROKER_PAYLOAD_MEMBERS) throw brokerRequestError();
    return captureBrokerValue(item, depth + 1, budget);
  }, brokerRequestError);
}

function capturedString(value: string, budget: CaptureBudget): string {
  const bytes = Buffer.byteLength(value);
  if (!isWellFormedUnicode(value) || bytes > MAX_BROKER_PAYLOAD_STRING_BYTES) {
    throw brokerRequestError();
  }
  debitBytes(budget, bytes);
  return value;
}

function envelopeBytes(value: Readonly<Record<string, unknown>>): number {
  let total = 0;
  for (const item of [value.requestId, value.brokerId, value.brokerContractVersion]) {
    if (typeof item === "string") total += Buffer.byteLength(item);
  }
  return total;
}

function debitBytes(budget: CaptureBudget, bytes: number): void {
  budget.bytes += bytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_PROTOCOL_FRAME_BYTES) {
    throw brokerRequestError();
  }
}

function safeKey(value: string): boolean {
  return value !== "__proto__" && value !== "prototype" && value !== "constructor"
    && isWellFormedUnicode(value) && Buffer.byteLength(value) <= 256;
}

function brokerRequestError(): Error { return new Error("provider broker request is invalid"); }
