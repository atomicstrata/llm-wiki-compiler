/**
 * Trust Guard decision core: composing per-check verdicts into one write
 * decision.
 *
 * The Trust Guard runs a set of independent checks over a proposed write. Each
 * check yields a {@link TrustCheckResult} carrying a {@link TrustVerdict}
 * (`pass` | `warn` | `block`). This module reduces a whole result set, together
 * with a routing flag, into exactly one {@link TrustDecision}.
 *
 * The composition is deliberately a pure, self-contained function with two
 * structural guarantees that downstream tasks (staging, quarantine, denial)
 * rely on:
 *
 * - **Total.** Every possible verdict set — including the empty set — and every
 *   value of `reviewRouted` maps to exactly one decision. There is no verdict
 *   combination for which the result is undefined, and no silent fall-through
 *   to a permissive `allow` default: the `allow` branch is reached only when it
 *   is positively earned (no warns, no blocks).
 *
 * - **Monotone in `block`.** Adding a `block` verdict can only make the decision
 *   stricter, never more permissive. If ANY check blocks, the decision is one
 *   of `stage-for-review` | `quarantine` | `deny` — never `allow` or
 *   `allow-with-warning`. Likewise a `warn` (absent any block) can never yield a
 *   plain `allow`; it raises the floor to `allow-with-warning`.
 *
 * Routing & quarantine on a block:
 * - If any blocking check requests quarantine (`quarantine: true`), the decision
 *   is `quarantine`, regardless of routing — untrusted content is isolated.
 * - Otherwise a **review-routed** surface yields `stage-for-review`, and a
 *   non-review-routed surface yields `deny`.
 *
 * This file has no I/O and no side effects; it is pure decision logic.
 */

/** A single check's outcome severity, lowest to highest. */
export type TrustVerdict = "pass" | "warn" | "block";

/** The composed write decision for a proposed write. */
export type TrustDecision =
  | "allow"
  | "allow-with-warning"
  | "stage-for-review"
  | "quarantine"
  | "deny";

/**
 * One Trust Guard check's result.
 *
 * `quarantine` is meaningful only on a `block` result: it marks the block as an
 * untrusted-content isolation case, which routes the composed decision to
 * `quarantine` instead of `stage-for-review`/`deny`.
 */
export interface TrustCheckResult {
  /** Stable machine-readable check identifier (e.g. `"untrusted-content"`). */
  code: string;
  /** This check's severity. */
  verdict: TrustVerdict;
  /** Human-readable explanation of the verdict. */
  message: string;
  /** When `true` on a `block`, isolate the write to quarantine. */
  quarantine?: boolean;
}

/** Routing context for the surface the write targets. */
export interface TrustRouting {
  /** Whether this surface stages risky writes for human review. */
  reviewRouted: boolean;
}

/** Decision for a result set containing at least one `block`. */
function decideBlocked(
  results: TrustCheckResult[],
  routing: TrustRouting
): TrustDecision {
  const quarantineRequested = results.some(
    (r) => r.verdict === "block" && r.quarantine === true
  );
  if (quarantineRequested) return "quarantine";
  return routing.reviewRouted ? "stage-for-review" : "deny";
}

/**
 * Compose a set of trust check results into one write decision.
 *
 * Total and monotone in `block` (see the file-level contract). Evaluates from
 * the strictest verdict down: any `block` routes through {@link decideBlocked};
 * otherwise any `warn` raises the floor to `allow-with-warning`; otherwise (all
 * `pass`, or no checks at all) the write is allowed.
 *
 * @param results - The per-check results for the proposed write.
 * @param routing - Routing context for the target surface.
 * @returns The single composed {@link TrustDecision}.
 */
export function composeTrustDecision(
  results: TrustCheckResult[],
  routing: TrustRouting
): TrustDecision {
  const hasBlock = results.some((r) => r.verdict === "block");
  if (hasBlock) return decideBlocked(results, routing);

  const hasWarn = results.some((r) => r.verdict === "warn");
  if (hasWarn) return "allow-with-warning";

  return "allow";
}

/** Wrap a list of PATH-FREE validator problems into one pass/block {@link TrustCheckResult}. */
export function checkFromProblems(code: string, problems: string[]): TrustCheckResult {
  if (problems.length === 0) return { code, verdict: "pass", message: `${code} ok` };
  return { code, verdict: "block", message: problems.join(" ") };
}
