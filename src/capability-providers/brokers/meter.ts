/**
 * @file src/capability-providers/brokers/meter.ts
 * @description Invocation-private broker request and aggregate usage meter.
 * It reserves category/effect counts and safely adds finite worst-case or
 * observed byte, token, cost, and command-output usage without overflow.
 */
import type { EffectiveProviderGrantV1 } from "../authority/types.js";
import {
  MAX_BROKER_REQUESTS, MAX_COMMANDS, MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES,
  MAX_HTTPS_AGGREGATE_TRANSFER_BYTES, MAX_HTTPS_REQUESTS,
  MAX_MODEL_AGGREGATE_BILLABLE_COST_USD, MAX_MODEL_AGGREGATE_TOKENS,
  MAX_MODEL_CALLS, MAX_MUTATING_EFFECTS, MAX_MUTATING_EFFECTS_PER_CLASS,
} from "../constants.js";
import type {
  HostBrokerBudgetV1, HostBrokerExecutionV1, HostBrokerUsageV1,
  PreparedHostBrokerCallV1,
} from "./types.js";

export interface HostBrokerUsageSnapshotV1 {
  readonly brokerRequests: number; readonly httpsRequests: number;
  readonly httpsTransferBytes: number; readonly modelCalls: number;
  readonly modelTokens: number; readonly modelCostUsd: number;
  readonly repositorySnapshots: number; readonly commandCalls: number;
  readonly commandAcceptedBytes: number; readonly mutatingEffects: number;
  readonly schedulerRequests: number; readonly emailRequests: number;
  readonly remoteEffectRequests: number;
  readonly effectClassCounts: Readonly<Record<string, number>>;
}

type MutableFields<T> = { -readonly [Key in keyof T]: T[Key] };
export type MutableBrokerUsage = Omit<
  MutableFields<HostBrokerUsageSnapshotV1>, "effectClassCounts"
> & { effectClassCounts: Record<string, number> };
type BrokerCategory = PreparedHostBrokerCallV1["category"];
type CategoryCounter = "httpsRequests" | "modelCalls" | "repositorySnapshots"
  | "commandCalls" | "schedulerRequests" | "emailRequests" | "remoteEffectRequests";
const CATEGORY_COUNTERS: Record<BrokerCategory, readonly [CategoryCounter, number]> = {
  https: ["httpsRequests", MAX_HTTPS_REQUESTS], model: ["modelCalls", MAX_MODEL_CALLS],
  repository: ["repositorySnapshots", Number.MAX_SAFE_INTEGER],
  command: ["commandCalls", MAX_COMMANDS],
  scheduler: ["schedulerRequests", Number.MAX_SAFE_INTEGER],
  email: ["emailRequests", Number.MAX_SAFE_INTEGER],
  "remote-effect": ["remoteEffectRequests", Number.MAX_SAFE_INTEGER],
};

/** Create the zeroed mutable meter retained only in dispatcher state. */
export function createBrokerUsage(): MutableBrokerUsage {
  return { brokerRequests: 0, httpsRequests: 0, httpsTransferBytes: 0,
    modelCalls: 0, modelTokens: 0, modelCostUsd: 0, repositorySnapshots: 0,
    commandCalls: 0, commandAcceptedBytes: 0, mutatingEffects: 0,
    schedulerRequests: 0, emailRequests: 0, remoteEffectRequests: 0,
    effectClassCounts: Object.create(null) };
}

/** Return a deeply frozen non-authoritative usage observation. */
export function snapshotBrokerUsage(usage: MutableBrokerUsage): HostBrokerUsageSnapshotV1 {
  return Object.freeze({ ...usage,
    effectClassCounts: Object.freeze({ ...usage.effectClassCounts }) });
}

/** Reserve the request, category, and optional mutating-effect counters. */
export function reserveBrokerRequest(
  usage: MutableBrokerUsage, grant: EffectiveProviderGrantV1,
  prepared: PreparedHostBrokerCallV1, effectClass: string | null,
): void {
  if (usage.brokerRequests >= Math.min(MAX_BROKER_REQUESTS, grant.bounds.brokerRequests)) throw capError();
  const [key, cap] = CATEGORY_COUNTERS[prepared.category];
  if (usage[key] >= cap) throw capError();
  usage.brokerRequests += 1;
  usage[key] += 1;
  if (effectClass !== null) reserveEffect(usage, grant, effectClass);
}

/** Add exact observed usage unless the broker already reserved its ceiling. */
export function debitObservedUsage(
  usage: MutableBrokerUsage, execution: HostBrokerExecutionV1,
  grant: EffectiveProviderGrantV1,
): boolean {
  return execution.usageReserved === true
    ? false : !reserveAggregateUsage(usage, execution.usage ?? {}, grant);
}

/** Atomically reserve finite aggregate usage without overflow. */
export function reserveAggregateUsage(
  usage: MutableBrokerUsage, observed: HostBrokerUsageV1,
  grant: EffectiveProviderGrantV1,
): boolean {
  const next = additions(usage, observed);
  const caps = aggregateCaps(grant);
  if (!next || next.httpsTransferBytes > caps.httpsTransferBytes
    || next.modelTokens > caps.modelTokens || next.modelCostUsd > caps.modelCostUsd
    || next.commandAcceptedBytes > caps.commandAcceptedBytes) return false;
  Object.assign(usage, next);
  return true;
}

/**
 * Release a previously reserved aggregate delta after a broker settles to its
 * exact host-observed usage. Amounts are clamped at zero so a settle can never
 * drive the meter negative or below zero remaining.
 */
export function settleReservedUsage(
  usage: MutableBrokerUsage, released: HostBrokerUsageV1,
): void {
  usage.httpsTransferBytes = releasedRemainder(usage.httpsTransferBytes, released.httpsTransferBytes);
  usage.modelTokens = releasedRemainder(usage.modelTokens, released.modelTokens);
  usage.modelCostUsd = releasedRemainder(usage.modelCostUsd, released.modelCostUsd);
  usage.commandAcceptedBytes = releasedRemainder(usage.commandAcceptedBytes, released.commandAcceptedBytes);
}

function releasedRemainder(current: number, released: number | undefined): number {
  const amount = released ?? 0;
  return amount > 0 && amount <= current ? current - amount : current;
}

/** Compute remaining reviewed hard ceilings for one broker execution. */
export function brokerBudget(
  usage: MutableBrokerUsage, grant: EffectiveProviderGrantV1,
): HostBrokerBudgetV1 {
  const caps = aggregateCaps(grant);
  return Object.freeze({
    httpsTransferBytes: remaining(caps.httpsTransferBytes, usage.httpsTransferBytes),
    modelTokens: remaining(caps.modelTokens, usage.modelTokens),
    modelCostUsd: remaining(caps.modelCostUsd, usage.modelCostUsd),
    commandAcceptedBytes: remaining(caps.commandAcceptedBytes, usage.commandAcceptedBytes),
  });
}

function aggregateCaps(grant: EffectiveProviderGrantV1): HostBrokerBudgetV1 {
  const maxima = grant.brokerMaximums;
  return {
    httpsTransferBytes: Math.min(MAX_HTTPS_AGGREGATE_TRANSFER_BYTES, maxima.httpsTransferBytes),
    modelTokens: Math.min(MAX_MODEL_AGGREGATE_TOKENS, maxima.modelTokens),
    modelCostUsd: Math.min(MAX_MODEL_AGGREGATE_BILLABLE_COST_USD, maxima.modelCostUsd),
    commandAcceptedBytes: Math.min(MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES, maxima.commandAcceptedBytes),
  };
}

function remaining(cap: number, used: number): number { return Math.max(0, cap - used); }

function reserveEffect(
  usage: MutableBrokerUsage, grant: EffectiveProviderGrantV1, effectClass: string,
): void {
  if (usage.mutatingEffects >= Math.min(MAX_MUTATING_EFFECTS, grant.bounds.mutatingEffects)) throw capError();
  const classCount = usage.effectClassCounts[effectClass] ?? 0;
  if (classCount >= MAX_MUTATING_EFFECTS_PER_CLASS) throw capError();
  usage.mutatingEffects += 1;
  usage.effectClassCounts[effectClass] = classCount + 1;
}

function additions(usage: MutableBrokerUsage, observed: HostBrokerUsageV1) {
  if (![observed.httpsTransferBytes, observed.modelTokens, observed.commandAcceptedBytes]
    .every((value) => value === undefined || Number.isSafeInteger(value))) return null;
  const httpsTransferBytes = safeSum(usage.httpsTransferBytes, observed.httpsTransferBytes);
  const modelTokens = safeSum(usage.modelTokens, observed.modelTokens);
  const modelCostUsd = safeSum(usage.modelCostUsd, observed.modelCostUsd);
  const commandAcceptedBytes = safeSum(usage.commandAcceptedBytes, observed.commandAcceptedBytes);
  return httpsTransferBytes === null || modelTokens === null || modelCostUsd === null
    || commandAcceptedBytes === null ? null
    : { httpsTransferBytes, modelTokens, modelCostUsd, commandAcceptedBytes };
}

function safeSum(current: number, added: number | undefined): number | null {
  const value = added ?? 0, sum = current + value;
  return Number.isFinite(value) && value >= 0 && Number.isFinite(sum) ? sum : null;
}
function capError(): Error { return new Error("provider broker aggregate cap is exhausted"); }
