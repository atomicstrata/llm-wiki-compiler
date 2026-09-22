/**
 * @file src/commands/product/apply.ts
 * @description `llmwiki product apply <bundle>` — the verb that approves and
 * applies what `product invoke` proposed. It is the other half of the honest
 * line `action.ts` prints: invoke says "NOT APPLIED, a separate operation
 * applies this", and this is that operation.
 *
 * THIS ONE WRITES, and every line it prints is chosen so an operator cannot
 * misread which of three things happened. A bundle whose mutations ran says the
 * wiki CHANGED. A bundle whose targets were already in the proposed state says
 * nothing was written and why — `skipped-idempotent` settles the run just as
 * successfully, and collapsing the two would tell an operator they created a
 * page that was already there. A run that stopped after some mutations landed
 * says PARTIALLY APPLIED, because "not applied" would be false: the counters,
 * not the arm, decide that sentence.
 *
 * IT NEVER REPORTS A NON-APPLIED OUTCOME AS SUCCESS. The seam carries the
 * executor's own state and problem codes verbatim, this file prints them, and
 * only a settled apply exits 0 — so a script that gates on the exit code can
 * never read a park at `recovery-required` as a completed change.
 *
 * IT ADDS NO AUTHORITY. The grant, the runtime, and the operator identity all
 * come from {@link cliProductApplyDependencies}; there is no flag here through
 * which a principal, a surface, or a grant could be presented.
 */

import { withQuietJson } from "../../cli/shared.js";
import {
  applyProductBundle, type ProductApplyMutationsV1, type ProductApplyResultV1,
} from "../../products/apply.js";
import { cliProductApplyDependencies } from "./host.js";
import { emitProduct, refusalPresentation, type ProductPresentationV1 } from "./render.js";

/** Options `product apply` accepts. */
export interface ProductApplyOptions {
  /** Emit the machine-readable envelope instead of the human lines. */
  json?: boolean;
}

/**
 * The line an operator must read when the bundle is applied.
 *
 * IT STATES A POSTCONDITION, NOT AN EVENT, and the wording is load-bearing.
 * `approveAndApplyOperationBundleLocked` returns the SAME result — terminal
 * state, counters, no problems — whether this call settled the run or found it
 * already settled, because a wrong-state stop carries the run's real state and
 * nothing else. So this verb cannot claim "this invocation wrote your page"
 * without asserting something it did not observe. What it CAN say truthfully in
 * both cases is that the bundle is applied and the proposed change is present,
 * which is the question an operator is actually asking. Re-running `apply` is
 * therefore idempotent and reports the same thing, exactly as the executor's own
 * exactly-once-effect protocol intends.
 */
const APPLIED_NOTICE =
  "APPLIED — this bundle is applied: its mutations ran against your wiki and "
  + "verified. What `product invoke` proposed is written.";

/**
 * The line for a settled run that wrote nothing because there was nothing to
 * write: every target was already in the exact state the bundle proposed.
 */
const ALREADY_PRESENT_NOTICE =
  "NOTHING WAS WRITTEN — every mutation found its target already in the exact "
  + "state this bundle proposed, so the run settled without changing your wiki.";

/** The line for a run that stopped without any of its mutations landing. */
const NOT_APPLIED_NOTICE =
  "NOT APPLIED — this run did not settle, and none of its mutations were "
  + "written to your wiki.";

/**
 * The line for a run that stopped AFTER some mutations landed. Saying "not
 * applied" here would be false, and it is the one case where the arm and the
 * truth differ — the counters decide it, not the status.
 */
const PARTIAL_NOTICE =
  "PARTIALLY APPLIED — some of this bundle's mutations already ran against "
  + "your wiki before the run stopped. Your wiki HAS changed.";

/** How an operator takes a stopped run further. */
const RECOVERY_HINT =
  "drive it with: llmwiki operation resume <run> — or unwind it with "
  + "llmwiki operation compensate <run>.";

/** The counters line: what the run did to the authoritative stores. */
function mutationLine(mutations: ProductApplyMutationsV1): string {
  return `mutations: ${mutations.applied} applied, ${mutations.skipped} skipped, `
    + `${mutations.failed} failed (of ${mutations.attempted} attempted)`;
}

/** The identity lines every settled outcome reports. */
function settledLines(bundleId: string, runId?: string, runState?: string): string[] {
  const run = runId === undefined ? "no run resolved" : runId;
  return [`bundle: ${bundleId}`, `run: ${run} → ${runState ?? "unresolved"}`];
}

/** Each carried problem code on its own line, verbatim. */
function problemLines(problems: readonly { code: string; message: string }[]): string[] {
  return problems.map((problem) => `problem: ${problem.code} — ${problem.message}`);
}

/** What one settled apply prints: the wiki changed, or nothing was there to change. */
function appliedPresentation(
  outcome: Extract<ProductApplyResultV1, { status: "applied" }>,
): ProductPresentationV1 {
  const notice = outcome.mutations.applied > 0 ? APPLIED_NOTICE : ALREADY_PRESENT_NOTICE;
  return {
    lines: [
      ...settledLines(outcome.bundleId, outcome.runId, outcome.runState),
      mutationLine(outcome.mutations), notice,
    ],
    code: 0, refused: false,
  };
}

/** The counters line, or none when the run never resolved far enough to have any. */
function mutationLines(mutations?: ProductApplyMutationsV1): string[] {
  return mutations === undefined ? [] : [mutationLine(mutations)];
}

/**
 * Which notice a stopped run gets, decided by the COUNTERS rather than the arm.
 * A run that stopped after some mutations landed has changed the wiki, and
 * printing "not applied" over it would be the one flatly false thing this verb
 * could say.
 */
function stoppedNotice(mutations?: ProductApplyMutationsV1): string {
  return mutations !== undefined && mutations.applied > 0 ? PARTIAL_NOTICE : NOT_APPLIED_NOTICE;
}

/** What one unsettled apply prints — driven by the counters, never by the arm. */
function notAppliedPresentation(
  outcome: Extract<ProductApplyResultV1, { status: "not-applied" }>,
): ProductPresentationV1 {
  return {
    lines: [
      ...settledLines(outcome.bundleId, outcome.runId, outcome.runState),
      ...mutationLines(outcome.mutations),
      ...problemLines(outcome.problems),
      stoppedNotice(outcome.mutations), RECOVERY_HINT,
    ],
    code: 1, refused: true,
  };
}

/** What one settled outcome prints, and the exit code it settles to. */
function applyPresentation(outcome: ProductApplyResultV1): ProductPresentationV1 {
  if (outcome.status === "refused") return refusalPresentation(outcome.reason);
  return outcome.status === "applied"
    ? appliedPresentation(outcome)
    : notAppliedPresentation(outcome);
}

/**
 * `llmwiki product apply <bundle>`. Approves and applies one bundle a product
 * invocation proposed, WRITING the change. Returns the exit code: 0 only when
 * the run settled applied.
 *
 * @param root - The project root the apply acts within.
 * @param bundle - The bundle manifest digest `product invoke` printed (or the
 *   bundle id / operation run id `operation list` reports).
 * @param options - `--json`.
 */
export async function productApplyCommand(
  root: string, bundle: string, options: ProductApplyOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WHOLE VERB in `--json` mode, as both action verbs are: the
  // apply takes the project lock, whose helper prints an advisory line on stdout
  // that would otherwise land ahead of the envelope and break `JSON.parse`.
  return withQuietJson(json, async () => {
    const outcome = await applyProductBundle(cliProductApplyDependencies(root), { bundle });
    return emitProduct(outcome, json, applyPresentation(outcome));
  });
}
