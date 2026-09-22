/**
 * @file src/preparations/attempts/retry.ts
 * @description Host-owned, bounded, fail-closed retry classification (design
 * section 16.5). The host — never provider prose — decides whether a settled
 * attempt failure may retry. Retry is authorized ONLY when the durable failure
 * carries a host problem code that is on the plan's closed retryable allowlist,
 * the attempt budget is not exhausted, and no structurally unsafe class is
 * present: no retry ever follows an unknown or applied effect, integrity
 * failure, any drift, a schema/custody failure, or an isolation/sandbox
 * outage. Every retry mints a NEW deterministic attempt id; the LOGICAL broker
 * effect identity stays stable across observation/retry so a retry that must
 * observe a prior effect never duplicates it. Read-only is not cost-free: the
 * cost preview exposes already-spent and maximum additional host-priced cost.
 */

import { createHash } from "node:crypto";
import { deriveAttemptId, type AttemptId, type PhaseInstanceId } from "../ids.js";
import type { PhaseBoundsV1 } from "../plan-types.js";
import type { PhaseSummaryV1 } from "../run-types.js";
import type { AttemptSettledPhaseState } from "./types.js";

const LOGICAL_EFFECT_DOMAIN = "llmwiki-preparation-logical-effect-v1";

/** One stable logical broker-effect identity, attempt-independent across retry. */
export type LogicalBrokerEffectId = `lef_${string}`;

/** The closed, plan-bound retry policy (design section 16.5). */
export interface AttemptPolicyV1 {
  readonly maximumAttempts: number;
  readonly retryableProblemCodes: readonly string[];
  readonly backoffClass: "none" | "short-host-jitter" | "provider-advised-bounded";
  readonly requireFreshAuthorityCheck: true;
}

/** The durable settled-failure facts a retry classifies from (host-owned). */
export interface RetryClassificationInputV1 {
  readonly policy: AttemptPolicyV1;
  readonly phaseInstanceId: PhaseInstanceId;
  readonly attemptIndex: number;
  readonly phaseState: AttemptSettledPhaseState;
  readonly problem?: string;
  readonly effectOutcomes: readonly string[];
}

/** The closed retry decision. */
export type RetryDecision =
  | { readonly kind: "retry"; readonly nextAttemptIndex: number; readonly nextAttemptId: AttemptId; readonly backoffClass: AttemptPolicyV1["backoffClass"] }
  | { readonly kind: "exhausted"; readonly reason: string }
  | { readonly kind: "forbidden"; readonly reason: string };

/** The paid-work cost preview for a checkpoint-less read-only retry (16.5). */
export interface RetryCostPreviewV1 {
  readonly alreadySpentBrokerRequests: number;
  readonly alreadySpentCostMicros: number | "unobserved";
  readonly maximumAdditionalBrokerRequests: number;
  readonly maximumAdditionalCostMicros: number;
}

/** One prior attempt's durable host-observed spend. */
export interface PriorAttemptSpendV1 {
  readonly brokerRequestCount: number;
  readonly costMicros: number | "unobserved";
}

/**
 * Structurally unsafe failure classes that NEVER retry regardless of the
 * allowlist. Matched as substrings of the host problem code so every drift,
 * integrity, schema, custody, publication, and isolation/sandbox outage the
 * executor and admission legs emit fails closed before the allowlist is read.
 */
const NEVER_RETRYABLE_SUBSTRINGS = Object.freeze([
  "drift", "integrity", "schema", "custody", "outcome-unknown", "recovery-required",
  "isolation-unavailable", "sandbox-unavailable", "publication-failed", "unobserved", "unrecorded",
]);

/** Effect outcomes that forbid retry: a retry could duplicate or misclassify them. */
const RETRY_FORBIDDING_EFFECTS = new Set(["applied", "already-applied", "outcome-unknown"]);

/** True when the host problem code names a structurally non-retryable class. */
function isNeverRetryable(problem: string): boolean {
  return NEVER_RETRYABLE_SUBSTRINGS.some((needle) => problem.includes(needle));
}

/** The unsafe-class refusal that precedes any allowlist or budget decision. */
function forbiddenClass(input: RetryClassificationInputV1): string | null {
  if (!Number.isSafeInteger(input.attemptIndex) || input.attemptIndex < 0) return "attempt-index-invalid";
  if (input.phaseState !== "failed") return `non-failed-outcome-${input.phaseState}`;
  if (input.effectOutcomes.some((outcome) => RETRY_FORBIDDING_EFFECTS.has(outcome))) return "effect-forbids-retry";
  if (input.problem === undefined) return "no-host-problem-code";
  if (isNeverRetryable(input.problem)) return `non-retryable-${input.problem}`;
  return null;
}

/**
 * Classify one settled failure into a bounded retry decision. Fails closed on
 * every structurally unsafe class first, then requires the problem code to be on
 * the plan's retryable allowlist, then requires unexhausted attempt budget; only
 * then does it mint the next deterministic attempt id (design section 16.5).
 */
export function classifyRetry(input: RetryClassificationInputV1): RetryDecision {
  const forbidden = forbiddenClass(input);
  if (forbidden !== null) return { kind: "forbidden", reason: forbidden };
  if (!input.policy.retryableProblemCodes.includes(input.problem!)) return { kind: "forbidden", reason: "problem-not-on-retryable-allowlist" };
  const nextAttemptIndex = input.attemptIndex + 1;
  if (!Number.isSafeInteger(nextAttemptIndex) || nextAttemptIndex >= input.policy.maximumAttempts) {
    return { kind: "exhausted", reason: "maximum-attempts-reached" };
  }
  return {
    kind: "retry", nextAttemptIndex, backoffClass: input.policy.backoffClass,
    nextAttemptId: deriveAttemptId(input.phaseInstanceId, nextAttemptIndex),
  };
}

/**
 * Derive the stable logical broker-effect identity for one effect position of a
 * phase instance. It is keyed by phase instance and effect index only, NEVER the
 * attempt, so the identity a retry must observe rather than duplicate is exactly
 * the one the prior attempt used (design section 16.5).
 */
export function deriveLogicalBrokerEffectId(phaseInstanceId: PhaseInstanceId, effectIndex: number): LogicalBrokerEffectId {
  if (!Number.isSafeInteger(effectIndex) || effectIndex < 0) throw new Error("logical broker effect index must be a nonnegative integer");
  const digest = createHash("sha256").update([LOGICAL_EFFECT_DOMAIN, phaseInstanceId, String(effectIndex)].join("\0"), "utf8").digest("hex");
  return `lef_${digest}`;
}

/**
 * Compute the paid-work preview for a permitted checkpoint-less retry: the sum
 * of prior host-observed spend (already spent, unrecoverable) and the exact
 * maximum additional host-priced cost one more attempt may incur under the
 * sealed phase ceilings. A single unobserved prior cost keeps the already-spent
 * cost honestly unobserved rather than understating it.
 */
export function retryCostPreview(prior: readonly PriorAttemptSpendV1[], bounds: PhaseBoundsV1): RetryCostPreviewV1 {
  const alreadySpentBrokerRequests = prior.reduce((sum, attempt) => sum + attempt.brokerRequestCount, 0);
  const anyUnobserved = prior.some((attempt) => attempt.costMicros === "unobserved");
  const alreadySpentCostMicros = anyUnobserved
    ? "unobserved"
    : prior.reduce((sum, attempt) => sum + (attempt.costMicros as number), 0);
  return {
    alreadySpentBrokerRequests, alreadySpentCostMicros,
    maximumAdditionalBrokerRequests: bounds.maximumBrokerRequestsPerAttempt,
    maximumAdditionalCostMicros: bounds.maximumCostMicrosPerAttempt,
  };
}

/**
 * Project one DURABLE phase summary onto the prior-attempt spend a cost preview
 * consumes. An absent durable dimension is `"unobserved"`, never 0: the summary
 * omits a dimension exactly when the runtime did not meter it, and a record
 * written before the durable spend fields existed carries no measurement at all.
 * Reading either as zero would report a billable prior attempt as free.
 */
function durableAttemptSpend(summary: PhaseSummaryV1): PriorAttemptSpendV1 {
  return {
    brokerRequestCount: summary.brokerRequestCount,
    costMicros: summary.costMicros ?? "unobserved",
  };
}

/**
 * The paid-work preview for retrying ONE phase instance, fed from the run's own
 * signed record rather than from a leg outcome held in memory. That is what makes
 * the preview survive the crash it exists for: the attempt whose spend it reports
 * is by definition over, and its process may be gone. A phase with no durable
 * summary was never attempted, so its already-spent figures are a structural
 * zero, not an unobserved measurement.
 *
 * IT REPORTS THE LAST ATTEMPT'S SPEND, NOT THE PHASE'S CUMULATIVE SPEND. A phase
 * instance keeps exactly one summary, and each new attempt's intent write
 * REPLACES it, so the spend of attempt N is gone once attempt N+1 records intent.
 * On a second or later retry this figure therefore understates what the phase has
 * cost so far. Reporting a cumulative total needs somewhere durable to accumulate
 * it — a per-attempt spend ledger or a running total on the summary — which is a
 * deliberate schema decision for whichever surface first needs the phase-level
 * number. This helper will not infer one it cannot read.
 */
export function durableRetryCostPreview(
  summaries: readonly PhaseSummaryV1[], phaseInstanceId: PhaseInstanceId, bounds: PhaseBoundsV1,
): RetryCostPreviewV1 {
  const summary = summaries.find((candidate) => candidate.phaseInstanceId === phaseInstanceId);
  return retryCostPreview(summary === undefined ? [] : [durableAttemptSpend(summary)], bounds);
}

/** Brand tripwires — see `src/types/brand-assertions.ts`. */
import type { BrandAssertFalse, BrandAssignable, BrandProbe } from "../../types/brand-assertions.js";

type _LogicalBrokerEffectIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, LogicalBrokerEffectId>>;
