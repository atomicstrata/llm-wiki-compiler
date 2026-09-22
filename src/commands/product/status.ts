/**
 * @file src/commands/product/status.ts
 * @description `llmwiki product status` — the readiness review AutoSci AS-1
 * §4.1 `setup` names: every optional capability the active product declares,
 * what it affects, what degrades without it, and how to turn it on.
 *
 * IT IS THE ONE PRODUCT VERB THAT CHANGES NOTHING. `invoke` stages a run,
 * `apply` writes; this reads a contract and a descriptor-only credential
 * registry and prints. Re-running it is safe by construction, which is exactly
 * what §4.1 asks for — there is no state for a second run to disturb.
 *
 * IT IS NOT PART OF `llmwiki status`, and that is a deliberate divergence from
 * the spec's suggested seam. `llmwiki status` is a credential-free snapshot of
 * WIKI CONTENT — counts, freshness, review queue — and product readiness is a
 * different question with a different audience. Folding one into the other
 * would make a content snapshot depend on provider state and would bury the
 * readiness answer inside an unrelated report.
 *
 * EXIT 0 WHEN A CAPABILITY IS MISSING. An unconfigured optional capability is
 * not an error: it is the product working as declared, with less. Only a review
 * that could not be produced at all is a non-zero exit.
 */

import { withQuietJson } from "../../cli/shared.js";
import { resolveActiveWorkspaceContract } from "../../products/action-resolve.js";
import { reviewProductReadiness, type ReadinessReportItemV1 } from "../../products/readiness.js";
import { resolveAuthorizedProviderPaths } from "../../capability-providers/packages/paths.js";
import { emitProduct, refusalPresentation, type ProductPresentationV1 } from "./render.js";
import { readRecordedSkips, recordSkip } from "../../products/readiness-skips.js";
import * as output from "../../utils/output.js";

/** CLI options for `llmwiki product status`. */
export interface ProductStatusOptions {
  json?: boolean;
  /** Record a decision to decline this capability (§4.1's explicit skips). */
  skip?: string;
  /** Clear a previously recorded skip. */
  unskip?: string;
}

/** How each state reads to an operator, in the imperative they need. */
const STATE_LINES: Readonly<Record<string, string>> = {
  // Still not "READY": invocation is never attempted, so the wording must not
  // promise a successful call. It also must not claim a credential where none
  // is declared — a requirement-named provider dimension has no credential and
  // reaches this state through the install and grant checks alone.
  available: "AVAILABLE — every declared check passed (credential where declared; provider install and project grant where a requirement names this); invocation itself was not attempted",
  // THE MOST USEFUL LINE IN THE SET: configuration looks complete and the call
  // would fail anyway, which is precisely what a ready/not-ready answer hides.
  "source-missing": "SOURCE MISSING — a credential is bound but its source does not resolve; this would fail if used",
  // Credentials can be perfect and the call still impossible: the provider
  // package a requirement allows is not installed.
  "provider-missing": "PROVIDER MISSING — credentials are fine, but no allowed provider package is installed",
  // Project-scoped: granted in one checkout is not granted in another.
  "grant-missing": "GRANT MISSING — this project has not granted the access this capability needs",
  "credential-bound": "CREDENTIAL BOUND — bound to a source this review cannot test without reading secrets",
  undeclared: "UNDECLARED — this package names the capability but not how to check it (legacy declaration)",
  "not-configured": "NOT CONFIGURED — this capability is unavailable and the product runs without it",
  // Still LISTED, deliberately: a recorded decision should stay visible, so a
  // reader months later can tell a deliberate skip from an oversight.
  skipped: "SKIPPED — you declined this capability; the product runs without it",
  // Never phrased as a nudge to configure: the review does not know that it is
  // unconfigured, and telling someone to set up what they may already have set
  // up is how a broken registry gets mistaken for a routine chore.
  unknown: "UNKNOWN — the credential registry could not be read, so readiness could not be determined",
};

/**
 * The lines one reviewed capability prints.
 *
 * The summaries are printed as the KEYS they are. Resolving them to prose needs
 * the package's own localization resource, which this command does not read, so
 * labelling them `affects` and printing an unresolved key would read as an
 * explanation while explaining nothing. Naming them as description keys is the
 * honest presentation until the resource is wired in.
 */
function itemLines(item: ReadinessReportItemV1): string[] {
  const lines = [`  ${item.dimensionId}: ${STATE_LINES[item.state] ?? item.state}`];
  if (item.summaryKey !== undefined) lines.push(`    affects (description key): ${item.summaryKey}`);
  if (item.degradedSummaryKey !== undefined) {
    lines.push(`    without it (description key): ${item.degradedSummaryKey}`);
  }
  if (item.credentialSlotId !== undefined) {
    lines.push(`    enable by binding a credential to slot: ${item.credentialSlotId}`);
  }
  return lines;
}

/**
 * Apply a `--skip`/`--unskip` decision, then read back what is recorded.
 *
 * A decision naming an UNDECLARED dimension is refused rather than stored: a
 * record of skipping something the product never offered is a typo preserved
 * forever, and it would never appear in any review to be noticed.
 */
async function applySkipDecision(
  root: string, options: ProductStatusOptions,
  dimensions: readonly { dimensionId: string }[],
): Promise<ReadonlySet<string> | null | { refused: string }> {
  const target = options.skip ?? options.unskip;
  if (target === undefined) return readRecordedSkips(root);
  if (!dimensions.some((dimension) => dimension.dimensionId === target)) {
    output.status("!", output.warn(`this product declares no capability named ${target}`));
    return { refused: `this product declares no capability named ${target}` };
  }
  const updated = await recordSkip(root, target, options.skip !== undefined);
  return updated === null ? { refused: "skip record is unreadable" } : updated;
}

/** What one produced review prints. */
function reviewPresentation(
  packId: string, items: readonly ReadinessReportItemV1[], keyless: boolean,
): ProductPresentationV1 {
  if (keyless) {
    return {
      lines: [
        `product: ${packId}`,
        "this product declares NO optional capabilities — everything it does runs with no credentials configured.",
      ],
      code: 0, refused: false,
    };
  }
  return {
    lines: [`product: ${packId}`, "optional capabilities:", ...items.flatMap(itemLines)],
    code: 0, refused: false,
  };
}

/**
 * `llmwiki product status`. Writes nothing. Returns the exit code.
 *
 * @param root - The project root whose active product is reviewed.
 * @param options - `--json`.
 */
export async function productStatusCommand(
  root: string, options: ProductStatusOptions = {},
): Promise<number> {
  const json = options.json === true;
  return withQuietJson(json, async () => {
    const resolved = await resolveActiveWorkspaceContract(root);
    if (resolved.status === "refused") {
      return emitProduct(resolved, json, refusalPresentation(resolved.reason));
    }
    // RESOLVING PROVIDER PATHS IS A WRITE: it creates the operator config and
    // cache roots. A review of a product with nothing to check must not leave
    // host directories behind, so the zero case never reaches the resolver.
    const dimensions = resolved.contract.productReadinessDimensions;
    const recorded = await applySkipDecision(root, options, dimensions);
    if (recorded !== null && "refused" in recorded) {
      return emitProduct({ status: "refused" as const, reason: recorded.refused }, json,
        refusalPresentation(recorded.refused));
    }
    const report = dimensions.length === 0
      ? { items: [], declaresNoOptionalCapabilities: true }
      : await reviewProductReadiness(
        await resolveAuthorizedProviderPaths(), dimensions, recorded,
        resolved.providerRequirements, root);
    const outcome = { status: "reviewed" as const, packId: resolved.packId, ...report };
    return emitProduct(
      outcome, json,
      reviewPresentation(resolved.packId, report.items, report.declaresNoOptionalCapabilities),
    );
  });
}
