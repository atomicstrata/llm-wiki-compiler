/**
 * @file src/capability-providers/runtime/observed-usage.ts
 * @description Project the invocation-private broker meter onto the host-observed
 * usage an admitted provider result carries. The meter is the ONLY place model
 * tokens and host-priced cost are counted: the model broker refuses to perform
 * billable I/O unless it first resolved a digest-pinned host price and reserved
 * an exact quote, so a settled meter is a complete — and, where a call failed
 * after reserving, a deliberately conservative — observation of the whole
 * invocation. Absence is never silently a zero: an unreadable meter or a value
 * that cannot be represented exactly surfaces the `"unobserved"` sentinel, which
 * the attempt bounds gate treats as unprovable and parks on.
 */
import {
  readHostBrokerUsage, type HostBrokerDispatcherV1, type HostBrokerUsageSnapshotV1,
} from "../brokers/dispatch.js";
import type { ProviderObservedUsageV1 } from "./result-admission.js";

/** The meter counts host-priced cost in USD; the attempt surface uses micro-USD. */
const MICROS_PER_USD = 1_000_000;

/**
 * Read the meter for one invocation, or null when the dispatcher cannot produce
 * a snapshot. A meter that cannot be read is an ABSENT observation, never an
 * empty one, so its dimensions fail closed to the sentinel.
 */
function meterSnapshot(dispatcher: HostBrokerDispatcherV1): HostBrokerUsageSnapshotV1 | null {
  try {
    return readHostBrokerUsage(dispatcher);
  } catch {
    return null;
  }
}

/** An exact nonnegative host token count, or the sentinel when it is not one. */
function observedTokens(modelTokens: number): number | "unobserved" {
  return Number.isSafeInteger(modelTokens) && modelTokens >= 0 ? modelTokens : "unobserved";
}

/**
 * Convert host-priced USD to micro-USD, always rounding UP so a fractional cost
 * is never under-reported against a sealed ceiling. Rounding is unconditional on
 * purpose: any tolerance that snapped a near-integer back down would have to
 * scale with the amount, and at a large enough cost that window swallows a real
 * fraction of a micro-USD. Overstating by at most one micro can only park a
 * phase; understating can commit one over its ceiling, so the bias goes here. A
 * negative, non-finite, or unrepresentable amount is not a measurement at all
 * and fails closed to the sentinel.
 */
function observedCostMicros(modelCostUsd: number): number | "unobserved" {
  if (!Number.isFinite(modelCostUsd) || modelCostUsd < 0) return "unobserved";
  const micros = Math.ceil(modelCostUsd * MICROS_PER_USD);
  return Number.isSafeInteger(micros) ? micros : "unobserved";
}

/**
 * Build the host-observed usage for one terminal result. Every field is named and
 * stamped from a host-owned counter — the broker-request count from the protocol
 * session and the token/cost dimensions from the invocation's own meter — so no
 * provider-reported figure can reach the admitted result through this seam.
 */
export function projectObservedUsage(
  dispatcher: HostBrokerDispatcherV1, observedBrokerRequestCount: number,
): ProviderObservedUsageV1 {
  return usageFrom(meterSnapshot(dispatcher), observedBrokerRequestCount);
}

/**
 * Project usage where no protocol session is in hand — a fault unwinding out of
 * the runtime. The meter's OWN request counter stands in for the session's, so a
 * fault still reports what the host dispatched rather than nothing.
 */
export function projectMeteredFaultUsage(
  dispatcher: HostBrokerDispatcherV1,
): ProviderObservedUsageV1 {
  const snapshot = meterSnapshot(dispatcher);
  return usageFrom(snapshot, snapshot?.brokerRequests ?? 0);
}

function usageFrom(
  snapshot: HostBrokerUsageSnapshotV1 | null, brokerRequestCount: number,
): ProviderObservedUsageV1 {
  return Object.freeze({
    brokerRequestCount,
    tokenCount: snapshot === null ? "unobserved" : observedTokens(snapshot.modelTokens),
    costMicros: snapshot === null ? "unobserved" : observedCostMicros(snapshot.modelCostUsd),
  });
}

/**
 * A fault that escaped the runtime AFTER the broker meter went live, carrying the
 * spend already observed when it happened. The runtime deliberately keeps such a
 * fault a THROW rather than converting it into a failed result: the executor
 * classifies a thrown leg `recovery-required`, which is never retryable, and
 * turning it into an ordinary failure would silently make an unknown-state leg
 * eligible for retry. The measurement rides along; the classification does not move.
 */
export class MeteredInvocationFaultV1 extends Error {
  readonly usage: ProviderObservedUsageV1;

  constructor(cause: unknown, usage: ProviderObservedUsageV1) {
    super(cause instanceof Error ? cause.message : "provider invocation faulted");
    this.name = "MeteredInvocationFaultV1";
    this.usage = usage;
    this.cause = cause;
  }
}

/** The spend a fault carries, or null when it carries no measurement at all. */
export function meteredFaultUsage(error: unknown): ProviderObservedUsageV1 | null {
  return error instanceof MeteredInvocationFaultV1 ? error.usage : null;
}
