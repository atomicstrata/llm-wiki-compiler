/**
 * @file src/capability-providers/brokers/dispatch.ts
 * @description Invocation-private closed broker dispatcher. Every captured
 * call serially re-resolves Task 5 authority, pricing, exposure, effect-plan,
 * and credential bindings; exact broker authority and aggregate counters are
 * checked before host I/O, and only host observations can mint receipts.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { captureOwnDataRecord } from "../../utils/runtime-capture.js";
import {
  readCredentialRegistryState, resolveCredentialHandle, takeCredentialBytesForBroker,
} from "../authority/credentials.js";
import { matchEffectPlanEntry } from "../authority/effect-plan.js";
import { resolveEffectiveProviderGrant } from "../authority/grants-resolve.js";
import type {
  EffectiveProviderGrantRequestV1, EffectiveProviderGrantV1, EffectPlanEntryV1,
  ProviderAuthorityAtomV1,
} from "../authority/types.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import type { BrokerIdV1, InvocationIdV1 } from "../types.js";
import { parseInvocationId } from "../ids.js";
import { createInvocationDeadline, type HostInvocationDeadlineV1, type MonotonicNowMs } from "./deadline.js";
import { prepareCommandBroker } from "./command.js";
import { prepareEmailBroker } from "./email.js";
import { prepareHttpsBroker } from "./https.js";
import { prepareModelBroker } from "./model.js";
import { deriveExternalEffectId, type ExternalEffectReceiptV1 } from "./receipts.js";
import {
  buildDispatchResult, credentialReflected, deadlineExceededResult,
  enforceInlineResponseCeiling, fallbackExecution, finalizePartial, receiptFor, statusFor,
} from "./dispatch-outcome.js";
import { createHostBrokerRegistry, resolveHostBrokerContract, type HostBrokerRegistryV1 } from "./registry.js";
import { prepareRemoteEffectBroker } from "./remote-effect.js";
import { prepareRepositoryBroker } from "./repository.js";
import { prepareSchedulerBroker } from "./scheduler.js";
import {
  assertHostBrokerAdaptersStable, captureHostBrokerAdapters,
  type CapturedHostBrokerAdaptersV1, type HostBrokerAdaptersV1,
} from "./adapter-capture.js";
export type { HostBrokerAdaptersV1 } from "./adapter-capture.js";
import {
  captureEffectStateAuthority, claimEffectStarted, lookupSettledEffectReceipt,
  type HostEffectClaimFactsV1, type HostEffectStateAuthorityV1,
} from "./effect-state.js";
export type { HostEffectStateAuthorityV1 } from "./effect-state.js";
import {
  brokerBudget, createBrokerUsage, debitObservedUsage, reserveAggregateUsage,
  reserveBrokerRequest, settleReservedUsage, snapshotBrokerUsage,
  type HostBrokerUsageSnapshotV1, type MutableBrokerUsage,
} from "./meter.js";
export type { HostBrokerUsageSnapshotV1 } from "./meter.js";
import {
  parseBrokerEffectReference, parseBrokerRequestEnvelope, type BrokerDispatchResultV1,
  type BrokerRequestEnvelopeV1, type HostBrokerDispatchV1, type HostBrokerExecutionContextV1,
  type HostBrokerExecutionV1, type PreparedHostBrokerCallV1,
} from "./types.js";
export type { HostBrokerDispatchV1 } from "./types.js";

const EMPTY_VISIBLE_BYTES: readonly Uint8Array[] = Object.freeze([]);

/** Wrap a provider-visible result with its host-only out-of-band bytes. */
function hostDispatch(
  result: BrokerDispatchResultV1, visibleBytes: readonly Uint8Array[] = EMPTY_VISIBLE_BYTES,
): HostBrokerDispatchV1 {
  return Object.freeze({ result, visibleBytes });
}

declare const dispatcherBrand: unique symbol;
/** Opaque invocation-private dispatcher; no mutable counters or adapters leak. */
export interface HostBrokerDispatcherV1 { readonly [dispatcherBrand]: true }

export interface CreateHostBrokerDispatcherOptionsV1 {
  readonly paths: AuthorizedProviderPaths;
  readonly authorityRequest: EffectiveProviderGrantRequestV1;
  readonly invocationId: InvocationIdV1;
  readonly brokers: HostBrokerAdaptersV1;
  readonly registry?: HostBrokerRegistryV1;
  readonly now?: () => Date;
  readonly effectState?: HostEffectStateAuthorityV1;
  readonly deadlineSignal?: AbortSignal;
  /**
   * Monotonic clock backing the wall-time deadline, injectable so the boundary
   * can be asserted without waiting on a real timer. Defaults to
   * `performance.now()`.
   */
  readonly monotonicNowMs?: MonotonicNowMs;
}

interface DispatcherState {
  readonly paths: AuthorizedProviderPaths; readonly request: EffectiveProviderGrantRequestV1;
  readonly initial: EffectiveProviderGrantV1; readonly invocationId: InvocationIdV1;
  readonly brokers: HostBrokerAdaptersV1; readonly brokerSource: HostBrokerAdaptersV1;
  readonly adapterCapture: CapturedHostBrokerAdaptersV1;
  readonly registry: HostBrokerRegistryV1;
  readonly now: () => Date; readonly usage: MutableBrokerUsage;
  readonly effectState: HostEffectStateAuthorityV1 | null;
  readonly parkedEffects: Set<string>;
  readonly deadline: HostInvocationDeadlineV1;
  brokerRequestIndex: number;
  tail: Promise<void>;
}
type MatchedEffect = ReturnType<typeof matchEffectPlanEntry> | null;
interface AuthorizedCall {
  readonly grant: EffectiveProviderGrantV1;
  readonly prepared: PreparedHostBrokerCallV1;
  readonly matched: MatchedEffect;
}
const dispatcherStates = new WeakMap<object, DispatcherState>();

/** Resolve and pin the initial Task 5 snapshot before accepting broker calls. */
export async function createHostBrokerDispatcher(
  options: CreateHostBrokerDispatcherOptionsV1,
): Promise<HostBrokerDispatcherV1> {
  const capturedOptions = captureDispatcherOptions(options);
  const brokerSource = capturedOptions.brokers;
  const adapterCapture = captureHostBrokerAdapters(brokerSource);
  const brokers = adapterCapture.brokers;
  const request = structuredClone(capturedOptions.authorityRequest);
  const initial = await resolveEffectiveProviderGrant(capturedOptions.paths, request);
  const dispatcher = Object.freeze({}) as HostBrokerDispatcherV1;
  dispatcherStates.set(dispatcher, {
    paths: capturedOptions.paths, request, initial,
    invocationId: parseInvocationId(capturedOptions.invocationId),
    brokers, brokerSource, adapterCapture,
    registry: capturedOptions.registry ?? createHostBrokerRegistry(),
    now: capturedOptions.now ?? (() => new Date()), usage: createBrokerUsage(),
    effectState: captureEffectStateAuthority(capturedOptions.effectState),
    parkedEffects: new Set(),
    deadline: createInvocationDeadline(
      capturedOptions.deadlineSignal, initial.bounds.wallTimeMs, capturedOptions.monotonicNowMs),
    brokerRequestIndex: 0, tail: Promise.resolve(),
  });
  return dispatcher;
}

function captureDispatcherOptions(
  value: CreateHostBrokerDispatcherOptionsV1,
): CreateHostBrokerDispatcherOptionsV1 {
  const captured = captureOwnDataRecord(value);
  const required = ["paths", "authorityRequest", "invocationId", "brokers"];
  const allowed = new Set([...required, "registry", "now", "effectState", "deadlineSignal", "monotonicNowMs"]);
  if (required.some((key) => !Object.hasOwn(captured, key))
    || Object.keys(captured).some((key) => !allowed.has(key))
    || (captured.now !== undefined && typeof captured.now !== "function")
    || (captured.deadlineSignal !== undefined && !(captured.deadlineSignal instanceof AbortSignal))
    || (captured.monotonicNowMs !== undefined && typeof captured.monotonicNowMs !== "function")) {
    throw new Error("provider broker dispatcher options are invalid");
  }
  return captured as unknown as CreateHostBrokerDispatcherOptionsV1;
}

/** Capture immediately, then serialize authority, counter, I/O, and receipt work. */
export async function dispatchHostBrokerRequest(
  dispatcher: HostBrokerDispatcherV1,
  request: unknown,
): Promise<BrokerDispatchResultV1> {
  return enforceInlineResponseCeiling((await serializedDispatch(dispatcher, request)).result);
}

/**
 * Host-only sibling of {@link dispatchHostBrokerRequest}. It returns the same
 * provider-visible result plus the large already-scanned response bytes so the
 * runtime can materialize them into the guest-read-only broker-response region
 * and hand the provider an opaque token. The provider-facing entrypoint never
 * exposes these bytes; a refused or credential-reflected response carries none.
 */
export async function dispatchHostBrokerRequestForHost(
  dispatcher: HostBrokerDispatcherV1,
  request: unknown,
): Promise<HostBrokerDispatchV1> {
  const dispatch = await serializedDispatch(dispatcher, request);
  return hostDispatch(enforceInlineResponseCeiling(dispatch.result), dispatch.visibleBytes);
}

/** Serialize authority, counter, I/O, and receipt work behind the dispatch tail. */
async function serializedDispatch(
  dispatcher: HostBrokerDispatcherV1, request: unknown,
): Promise<HostBrokerDispatchV1> {
  const envelope = parseBrokerRequestEnvelope(request);
  const state = requireState(dispatcher);
  const previous = state.tail;
  let release = () => {};
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await dispatchCaptured(state, envelope); }
  finally { release(); }
}

/** Return a frozen host-observed aggregate snapshot, never a mutable meter. */
export function readHostBrokerUsage(dispatcher: HostBrokerDispatcherV1): HostBrokerUsageSnapshotV1 {
  return snapshotBrokerUsage(requireState(dispatcher).usage);
}

async function dispatchCaptured(
  state: DispatcherState,
  envelope: BrokerRequestEnvelopeV1,
): Promise<HostBrokerDispatchV1> {
  const requestIndex = takeBrokerRequestIndex(state);
  const startedAt = timestamp(state.now());
  const callTime = new Date(startedAt);
  const { grant, prepared, matched } = await authorizeCall(
    state, envelope, requestIndex, callTime,
  );
  reserveBrokerRequest(state.usage, grant, prepared, matched?.entry.effectClass ?? null);
  assertHostBrokerAdaptersStable(state.brokerSource, state.adapterCapture);
  // Read the CLOCK, not just the signal: an unfired timeout callback is not
  // evidence that the budget survives. This is the last gate before any
  // adapter is reached.
  if (state.deadline.expired()) return hostDispatch(deadlineExceededResult(envelope, matched !== null));
  if (matched) {
    const replayed = await replaySettledEffect(state, envelope, grant, matched);
    if (replayed) return replayed;
  }
  const credential = await takeCredential(
    state, grant, envelope.brokerId, prepared.credentialSlotId, prepared.credentialOperation,
  );
  try {
    await claimMutation(state, envelope, grant, matched, startedAt);
    const execution = await executeCall(prepared, credential, matched?.entry ?? null, {
      budget: brokerBudget(state.usage, grant),
      reserve: (requested) => reserveAggregateUsage(state.usage, requested, grant),
      settle: (released) => settleReservedUsage(state.usage, released),
      deadline: state.deadline,
    });
    return await finishDispatch(state, envelope, grant, matched, execution, credential, startedAt);
  } finally { credential?.fill(0); }
}

async function authorizeCall(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  requestIndex: number, callTime: Date,
): Promise<AuthorizedCall> {
  if (!resolveHostBrokerContract(state.registry, envelope.brokerId, envelope.brokerContractVersion)) {
    throw new Error("provider broker contract is unavailable");
  }
  const grant = await recheckAuthority(state);
  const prepared = prepareCall(state, envelope, grant, callTime);
  assertAuthority(grant.authority, prepared.authority);
  const matched = matchEffect(state, envelope, prepared, requestIndex);
  return { grant, prepared, matched };
}

/**
 * Consult the injected effect authority for a receipt already settled under
 * this exact idempotency identity and return it as already-applied instead of
 * re-executing the mutation. An unresolved effect has no settled receipt, so it
 * still falls through to the claim path and parks.
 */
async function replaySettledEffect(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  grant: EffectiveProviderGrantV1, matched: NonNullable<MatchedEffect>,
): Promise<HostBrokerDispatchV1 | null> {
  if (!state.effectState) throw new Error("provider broker effect-state authority is unavailable");
  const receipt = await lookupSettledEffectReceipt(
    state.effectState, matched.entry.effectId, matched.entry.idempotencyKey,
  );
  if (!receipt) return null;
  if (receipt.grantSnapshotDigest !== grant.grantSnapshotDigest
    || receipt.providerPinDigest !== grant.providerPinDigest
    || receipt.effectPlanEntryDigest !== matched.entryDigest
    || receipt.effectClass !== matched.entry.effectClass
    || receipt.targetIdentity !== matched.entry.targetIdentity
    || receipt.requestDigest !== matched.entry.requestDigest) {
    throw new Error("provider broker settled receipt does not match the approved effect");
  }
  return hostDispatch(Object.freeze({
    schemaVersion: 1, requestId: envelope.requestId, brokerId: envelope.brokerId,
    status: statusFor(receipt.outcome), output: Object.freeze({ alreadyApplied: true }),
    receipt, completion: null,
  }));
}

async function claimMutation(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  grant: EffectiveProviderGrantV1, matched: MatchedEffect, startedAt: string,
): Promise<void> {
  if (!matched) return;
  if (!state.effectState) throw new Error("provider broker effect-state authority is unavailable");
  if (state.parkedEffects.has(matched.entry.effectId)) {
    throw new Error("provider broker effect is started");
  }
  await claimEffectStarted(
    state.effectState, matched.entry.effectId,
    effectClaimFacts(state, envelope, grant, matched, startedAt),
  );
  state.parkedEffects.add(matched.entry.effectId);
}

function effectClaimFacts(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  grant: EffectiveProviderGrantV1, matched: NonNullable<MatchedEffect>, startedAt: string,
): HostEffectClaimFactsV1 {
  return Object.freeze({
    schemaVersion: 1, invocationId: state.invocationId,
    providerPinDigest: grant.providerPinDigest, grantSnapshotDigest: grant.grantSnapshotDigest,
    effectPlanEntryDigest: matched.entryDigest, brokerId: envelope.brokerId,
    brokerContractVersion: envelope.brokerContractVersion,
    effectClass: matched.entry.effectClass, targetIdentity: matched.entry.targetIdentity,
    requestDigest: matched.entry.requestDigest, idempotencyKey: matched.entry.idempotencyKey,
    startedAt, rollbackSemantics: matched.entry.rollbackSemantics,
  });
}

async function finishDispatch(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  grant: EffectiveProviderGrantV1, matched: MatchedEffect,
  rawExecution: HostBrokerExecutionV1, credential: Buffer | null, startedAt: string,
): Promise<HostBrokerDispatchV1> {
  const execution = finalizePartial(rawExecution, matched !== null);
  const reflected = credentialReflected(credential, execution);
  const usageExceeded = debitObservedUsage(state.usage, execution, grant);
  const completion = captureCompletion(state, matched !== null, execution);
  const receipt = matched ? receiptFor(
    state.invocationId, envelope, grant, matched, completion.execution,
    startedAt, completion.completedAt, reflected,
  ) : null;
  if (receipt) await settleEffect(state, receipt);
  const result = buildDispatchResult(
    envelope, completion.execution, receipt, reflected || usageExceeded,
  );
  const visibleBytes = reflected ? EMPTY_VISIBLE_BYTES : (completion.execution.visibleBytes ?? EMPTY_VISIBLE_BYTES);
  return hostDispatch(result, visibleBytes);
}

async function settleEffect(
  state: DispatcherState, receipt: ExternalEffectReceiptV1,
): Promise<void> {
  if (!state.effectState) throw new Error("provider broker effect-state authority is unavailable");
  await state.effectState.settle(receipt);
  state.parkedEffects.delete(receipt.effectId);
}

function captureCompletion(
  state: DispatcherState, mutating: boolean, execution: HostBrokerExecutionV1,
): { readonly execution: HostBrokerExecutionV1; readonly completedAt?: string } {
  try { return { execution, completedAt: timestamp(state.now()) }; }
  catch {
    return { execution: Object.freeze({
      outcome: mutating ? "outcome-unknown" : "unavailable",
      output: Object.freeze({ reason: "broker completion clock is unavailable" }),
      ...(execution.usage ? { usage: execution.usage } : {}),
      ...(execution.usageReserved ? { usageReserved: true as const } : {}),
    }) };
  }
}

async function recheckAuthority(
  state: DispatcherState,
): Promise<EffectiveProviderGrantV1> {
  const current = await resolveEffectiveProviderGrant(state.paths, state.request);
  if (current.grantSnapshotDigest !== state.initial.grantSnapshotDigest
    || current.effectPlanDigest !== state.initial.effectPlanDigest
    || current.priceTableDigest !== state.initial.priceTableDigest
    || current.exposure.inputExposureSetDigest !== state.initial.exposure.inputExposureSetDigest) {
    throw new Error("provider broker authority has drifted");
  }
  return current;
}

function prepareCall(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  grant: EffectiveProviderGrantV1, callTime: Date,
): PreparedHostBrokerCallV1 {
  switch (envelope.brokerId) {
    case "https": return prepareHttpsBroker(envelope, state.brokers.https);
    case "model": return prepareModelBroker(envelope, state.brokers.model, {
      paths: state.paths, priceTableDigest: grant.priceTableDigest, now: callTime,
    });
    case "repository": return prepareRepositoryBroker(envelope, state.brokers.repository);
    case "command": return prepareCommandBroker(envelope, state.brokers.command);
    case "scheduler": return prepareSchedulerBroker(envelope, state.brokers.scheduler);
    case "email": return prepareEmailBroker(envelope, state.brokers.email);
    case "remote-effect": return prepareRemoteEffectBroker(envelope, state.brokers["remote-effect"]);
    default: throw new Error("provider broker contract is unavailable");
  }
}

function assertAuthority(
  actual: readonly ProviderAuthorityAtomV1[], required: readonly ProviderAuthorityAtomV1[],
): void {
  const digests = new Set(actual.map((atom) => canonicalDigest(atom)));
  if (required.some((atom) => !digests.has(canonicalDigest(atom)))) {
    throw new Error("provider broker authority is missing");
  }
}

function matchEffect(
  state: DispatcherState, envelope: BrokerRequestEnvelopeV1,
  prepared: PreparedHostBrokerCallV1, requestIndex: number,
) {
  if (!prepared.effect) {
    if (envelope.effect !== null) throw new Error("provider broker effect is not approved");
    return null;
  }
  if (envelope.effect === null) throw new Error("provider broker effect is not approved");
  const reference = parseBrokerEffectReference(envelope.effect);
  const derivedEffectId = deriveExternalEffectId(
    state.request.preparationRunId, state.invocationId, requestIndex,
  );
  if (reference.effectId !== derivedEffectId) {
    throw new Error("provider broker effect ID does not match the broker request index");
  }
  const planned = state.request.effectPlan.entries.find((entry) => entry.effectId === reference.effectId);
  if (!planned) throw new Error("provider broker effect is not approved");
  return matchEffectPlanEntry(state.request.effectPlan, {
    ...planned, brokerId: envelope.brokerId,
    brokerContractVersion: envelope.brokerContractVersion,
    effectClass: prepared.effect.effectClass, targetIdentity: prepared.effect.targetIdentity,
    requestDigest: prepared.effect.requestDigest, expectedBounds: prepared.effect.expectedBounds,
  });
}

function takeBrokerRequestIndex(state: DispatcherState): number {
  const index = state.brokerRequestIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index === Number.MAX_SAFE_INTEGER) {
    throw new Error("provider broker request index is exhausted");
  }
  state.brokerRequestIndex = index + 1;
  return index;
}

async function takeCredential(
  state: DispatcherState, grant: EffectiveProviderGrantV1,
  brokerId: BrokerIdV1, slotId: string | null, operation: string | null,
): Promise<Buffer | null> {
  if (slotId === null) return null;
  if (operation === null) throw new Error("provider broker credential authority is missing");
  const matches = grant.authority.filter((atom) => atom.kind === "credential.use"
    && atom.brokerId === brokerId && atom.credentialSlotId === slotId
    && atom.operation === operation
    && atom.credentialHandleId !== null);
  if (matches.length !== 1) throw new Error("provider broker credential authority is unavailable");
  const read = await readCredentialRegistryState(state.paths);
  if (read.kind !== "ok") throw new Error("provider broker credential is unavailable");
  const access = await resolveCredentialHandle(
    read.registry, slotId, matches[0].credentialHandleId!, brokerId,
  );
  return takeCredentialBytesForBroker(access, brokerId);
}

async function executeCall(
  prepared: PreparedHostBrokerCallV1, secret: Buffer | null,
  effect: EffectPlanEntryV1 | null, context: HostBrokerExecutionContextV1,
): Promise<HostBrokerExecutionV1> {
  try { return await prepared.execute(secret, effect, context); }
  catch { return fallbackExecution(prepared.effect !== null); }
}

function timestamp(value: Date): string {
  if (!(value instanceof Date)) throw new Error("provider broker clock is invalid");
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("provider broker clock is invalid");
  return new Date(milliseconds).toISOString();
}
function requireState(dispatcher: HostBrokerDispatcherV1): DispatcherState {
  const state = dispatcherStates.get(dispatcher);
  if (!state) throw new Error("provider broker dispatcher is invalid");
  return state;
}
