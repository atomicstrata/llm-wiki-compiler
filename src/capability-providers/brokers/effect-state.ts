/**
 * @file src/capability-providers/brokers/effect-state.ts
 * @description Captured host seam for atomic durable effect claims and receipt
 * settlement. Storage is deliberately supplied by future orchestration.
 */
import { captureExactRecord } from "../../utils/runtime-capture.js";
import type { ProviderRollbackSemanticsV1 } from "../authority/types.js";
import type {
  BrokerIdV1, EffectIdV1, InvocationIdV1, SemanticVersionV1, Sha256Digest,
} from "../types.js";
import { captureExternalEffectReceipt, type ExternalEffectReceiptV1 } from "./receipts.js";

type HostEffectClaimStateV1 =
  | "newly-claimed" | "started" | "unresolved" | "settled";

/** Exact host facts durably bound before one mutating adapter call. */
export interface HostEffectClaimFactsV1 {
  readonly schemaVersion: 1;
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
  readonly rollbackSemantics: ProviderRollbackSemanticsV1;
}

/** Injected atomic durable effect-state authority; no storage is implemented here. */
export interface HostEffectStateAuthorityV1 {
  claimStarted(effectId: EffectIdV1, facts: HostEffectClaimFactsV1): Promise<unknown>;
  settle(receipt: ExternalEffectReceiptV1): Promise<void>;
  settledReceipt(effectId: EffectIdV1, idempotencyKey: string): Promise<unknown>;
}

/** Capture the authority methods without retaining a caller-owned record. */
export function captureEffectStateAuthority(
  value: HostEffectStateAuthorityV1 | undefined,
): HostEffectStateAuthorityV1 | null {
  if (value === undefined) return null;
  const captured = captureExactRecord(value, ["claimStarted", "settle", "settledReceipt"]);
  if (typeof captured.claimStarted !== "function" || typeof captured.settle !== "function"
    || typeof captured.settledReceipt !== "function") {
    throw authorityError("is invalid");
  }
  return Object.freeze({
    claimStarted: captured.claimStarted as HostEffectStateAuthorityV1["claimStarted"],
    settle: captured.settle as HostEffectStateAuthorityV1["settle"],
    settledReceipt: captured.settledReceipt as HostEffectStateAuthorityV1["settledReceipt"],
  });
}

/**
 * Look up an already-settled receipt for one mutating effect by its exact
 * idempotency identity. A returned value is re-validated into a frozen receipt
 * and must match the queried effect and key; anything else fails closed.
 */
export async function lookupSettledEffectReceipt(
  authority: HostEffectStateAuthorityV1,
  effectId: EffectIdV1,
  idempotencyKey: string,
): Promise<ExternalEffectReceiptV1 | null> {
  const result = await authority.settledReceipt(effectId, idempotencyKey);
  if (result === null || result === undefined) return null;
  let receipt: ExternalEffectReceiptV1;
  try { receipt = captureExternalEffectReceipt(result); }
  catch { throw authorityError("returned an invalid settled receipt"); }
  if (receipt.effectId !== effectId || receipt.idempotencyKey !== idempotencyKey) {
    throw authorityError("returned a settled receipt for a different effect");
  }
  return receipt;
}

/** Atomically claim started and accept only the exact newly-claimed response. */
export async function claimEffectStarted(
  authority: HostEffectStateAuthorityV1,
  effectId: EffectIdV1,
  facts: HostEffectClaimFactsV1,
): Promise<void> {
  const result = await authority.claimStarted(effectId, facts);
  let captured: Readonly<Record<string, unknown>>;
  try { captured = captureExactRecord(result, ["schemaVersion", "state"]); }
  catch { throw authorityError("returned an invalid claim result"); }
  if (captured.schemaVersion !== 1 || !claimState(captured.state)) {
    throw authorityError("returned an invalid claim result");
  }
  if (captured.state !== "newly-claimed") {
    throw new Error(`provider broker effect is ${captured.state}`);
  }
}

function claimState(value: unknown): value is HostEffectClaimStateV1 {
  return value === "newly-claimed" || value === "started"
    || value === "unresolved" || value === "settled";
}

function authorityError(detail: string): Error {
  return new Error(`provider broker effect-state authority ${detail}`);
}
