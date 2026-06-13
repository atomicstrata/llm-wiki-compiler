/**
 * Pure review-policy evaluation.
 *
 * The compile pipeline produces review signals from the final rendered page
 * (confidence/contradictions from frontmatter plus independently-computed
 * schema/provenance violations). This module contains only the deterministic
 * policy decision: given normalized project policy and those signals, return
 * the structured reasons that require the page to be held for review.
 */

import type { LintResult } from "../linter/types.js";

/** Policy reasons stored on review candidates and surfaced in CLI output. */
export type HeldReasonCode =
  | "low-confidence"
  | "contradicted"
  | "schema-violating"
  | "provenance-violating"
  | "all"
  | "manual-review-requested";

/** Structured reason a generated page was held for review. */
export interface HeldReason {
  code: HeldReasonCode;
  detail?: string;
}

/** Candidate origin: policy-selected or explicitly forced by compile --review. */
export type ReviewMode = "policy" | "forced";

/** Configurable review policy modes. */
export type ReviewPolicyMode = Exclude<HeldReasonCode, "manual-review-requested"> | "off";

/** How low-confidence policy treats a missing confidence signal. */
export type MissingConfidencePolicy = "low" | "ok";

/** Normalized project review policy. */
export interface ReviewPolicy {
  hold: ReviewPolicyMode[];
  lowConfidenceThreshold: number;
  treatMissingConfidenceAs: MissingConfidencePolicy;
}

/** Signals used by review policy evaluation for one generated page. */
export interface PolicySignals {
  confidence?: number;
  contradicted: boolean;
  schemaViolations: LintResult[];
  provenanceViolations: LintResult[];
}

/** True when policy cannot hold any page. */
export function isPolicyOff(policy: ReviewPolicy): boolean {
  return policy.hold.length === 0 || policy.hold.includes("off");
}

/** Return every policy reason that fires for this page. Empty means write live. */
export function evaluatePolicy(signals: PolicySignals, policy: ReviewPolicy): HeldReason[] {
  if (isPolicyOff(policy)) return [];
  const reasons: HeldReason[] = [];
  for (const mode of policy.hold) {
    const reason = reasonForMode(mode, signals, policy);
    if (reason) reasons.push(reason);
  }
  return reasons;
}

/** Evaluate one configured policy mode. */
function reasonForMode(
  mode: ReviewPolicyMode,
  signals: PolicySignals,
  policy: ReviewPolicy,
): HeldReason | null {
  if (mode === "all") return { code: "all" };
  if (mode === "low-confidence") return lowConfidenceReason(signals, policy);
  if (mode === "contradicted" && signals.contradicted) return { code: "contradicted" };
  if (mode === "schema-violating" && signals.schemaViolations.length > 0) {
    return { code: "schema-violating", detail: summarizeViolations(signals.schemaViolations) };
  }
  if (mode === "provenance-violating" && signals.provenanceViolations.length > 0) {
    return { code: "provenance-violating", detail: summarizeViolations(signals.provenanceViolations) };
  }
  return null;
}

/** Build the low-confidence reason, including the missing-signal policy. */
function lowConfidenceReason(signals: PolicySignals, policy: ReviewPolicy): HeldReason | null {
  if (signals.confidence === undefined) {
    if (policy.treatMissingConfidenceAs === "low") {
      return { code: "low-confidence", detail: "confidence missing" };
    }
    return null;
  }
  if (signals.confidence < policy.lowConfidenceThreshold) {
    return {
      code: "low-confidence",
      detail: `confidence ${signals.confidence} < ${policy.lowConfidenceThreshold}`,
    };
  }
  return null;
}

/** Compact violation summary for candidate display. */
function summarizeViolations(violations: LintResult[]): string {
  const first = violations[0];
  const suffix = violations.length === 1 ? "" : ` (+${violations.length - 1} more)`;
  return `${first.rule}${suffix}`;
}

