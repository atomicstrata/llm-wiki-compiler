/**
 * @file src/commands/product/action.ts
 * @description `llmwiki product preview <token>` and
 * `llmwiki product invoke <token>` — the two verbs that run an activated
 * product's actions.
 *
 * THE HONEST LINE IS THE POINT OF THIS FILE. `invoke` drives a certified
 * preparation to a Milestone A HANDOFF: the bundle it produces carries a real,
 * reviewable create mutation, and NOTHING IS APPLIED. No page, entity or
 * artifact is written; approving and applying a bundle is a separate operation.
 * A CLI that printed "created" — or even just a run id and a digest with no
 * further word — would leave an operator believing their wiki changed. So
 * `handed-off` prints {@link HANDOFF_NOTICE} beside the identifiers, every time,
 * on the success path.
 *
 * BOTH VERBS SHARE ONE BODY, for the reason `preparation stage` shares one with
 * `preview`: they differ in the service method, the grant they declare, and how
 * an outcome prints, and in nothing else. Two adapters would be two places for
 * `--input` to be parsed differently, and the whole value of preview is that it
 * cannot diverge from the invocation it previews.
 *
 * PREVIEW DECLARES NO GRANT AND THAT IS NOT COSMETIC. The preparation service
 * charges nothing for `preview` and `preparation.run` for `stage`; the product
 * service delegates to it, so preview is grant-free by construction rather than
 * by a second table that could disagree.
 */

import { withQuietJson } from "../../cli/shared.js";
import type { PreparationGrant } from "../../preparations/principals.js";
import type {
  ProductInvocationRequestV1, ProductInvokeResultV1, ProductPreviewResultV1,
} from "../../products/service.js";
import { cliProviderInvocation, cliProductService } from "./host.js";
import {
  collectActionInput, DEFAULT_PRODUCT_WORKSPACE, type ProductActionOptions,
} from "./inputs.js";
import {
  compiledActionLines, emitProduct, refusalPresentation,
  type ProductPresentationV1,
} from "./render.js";

/**
 * The line an operator must read on every successful invocation.
 *
 * It names the three things a "run id + digest" success line does not: that
 * nothing was applied, that the wiki is unchanged, and that a separate operation
 * applies the proposal.
 */
const HANDOFF_NOTICE =
  "NOT APPLIED — this produced a reviewable bundle that PROPOSES the change. "
  + "Nothing was written to your wiki: no page, entity, or artifact was created, "
  + "updated, or deleted. Approving and applying a bundle is a separate operation.";

/**
 * Where the proposal can be read, and how an operator takes it further.
 *
 * BOTH HALVES, because either alone misleads. Naming only the review command
 * would leave an operator hunting for the approve verb; naming only the approve
 * verb would invite applying a bundle nobody read. The run id is what `apply`
 * takes, and it is printed on the line above this one.
 *
 * THIS LINE IS A CLAIM ABOUT WHICH COMMANDS EXIST, which is exactly the kind of
 * prose that goes stale: it previously said no command approved a bundle, and
 * `product apply` made that false. A subprocess test reads this text back out of
 * the built CLI so the claim cannot rot again unnoticed.
 */
const HANDOFF_REVIEW =
  "review it with: llmwiki operation inspect <bundle manifest digest> — then "
  + "apply it with: llmwiki product apply <bundle manifest digest>, which "
  + "requires the operation-bundle.approve grant and DOES write the change.";

/** What `preview` costs: nothing. */
const PREVIEW_GRANTS: readonly PreparationGrant[] = [];

/** What `invoke` costs — the same grant staging a preparation costs. */
const INVOKE_GRANTS: readonly PreparationGrant[] = ["preparation.run"];

/** What one settled preview prints. */
function previewPresentation(outcome: ProductPreviewResultV1): ProductPresentationV1 {
  if (outcome.status === "refused") return refusalPresentation(outcome.reason);
  const lines = compiledActionLines(outcome.action);
  if (outcome.status === "previewed") {
    return {
      lines: [...lines, `dry run only — nothing was written; invoking would record a run in ${outcome.workspaceId}`],
      code: 0, refused: false,
    };
  }
  // THE THIRD ARM STAYS THIRD. The action COMPILED — so the plan digest above is
  // real and an alias-parity check works — and only the substrate's dry run
  // declined. Collapsing it into `refused` would hide a digest the caller can use.
  return {
    lines: [...lines, `the action compiled, but the dry run declined: ${outcome.reason}`],
    code: 1, refused: true,
  };
}

/** What one settled invocation prints. */
function invokePresentation(outcome: ProductInvokeResultV1): ProductPresentationV1 {
  if (outcome.status === "refused") return refusalPresentation(outcome.reason);
  return settledPresentation(outcome, compiledActionLines(outcome.action));
}

/**
 * The four arms that COMPILED, split from the refusal so each stays one branch:
 * a refusal has no action summary to print, and every arm below does.
 */
function settledPresentation(
  outcome: Exclude<ProductInvokeResultV1, { status: "refused" }>, lines: string[],
): ProductPresentationV1 {
  if (outcome.status === "handed-off") return handoffPresentation(outcome, lines);
  if (outcome.status === "awaiting-review") return awaitingReviewPresentation(outcome, lines);
  if (outcome.status === "nothing-to-propose") return nothingToProposePresentation(outcome, lines);
  return incompletePresentation(outcome, lines);
}

/**
 * What a run that settled without reaching a handoff prints: the runner's own
 * state, carried verbatim rather than reclassified, and never reported as
 * success — which is what the non-zero code is for.
 */
function incompletePresentation(
  outcome: Extract<ProductInvokeResultV1, { status: "incomplete" }>, lines: string[],
): ProductPresentationV1 {
  const detail = outcome.reason === undefined ? "" : `: ${outcome.reason}`;
  return {
    lines: [...lines, `run ${outcome.runId} did not reach a handoff (${outcome.runState})${detail}`],
    code: 1, refused: true,
  };
}

/** What a run that reached its Milestone A handoff prints. */
function handoffPresentation(
  outcome: Extract<ProductInvokeResultV1, { status: "handed-off" }>, lines: string[],
): ProductPresentationV1 {
  return {
    lines: [
      ...lines, `run: ${outcome.runId}`,
      `bundle manifest digest: ${outcome.bundleManifestDigest}`,
      HANDOFF_NOTICE, HANDOFF_REVIEW,
    ],
    code: 0, refused: false,
  };
}

/**
 * What a run with nothing left to propose prints.
 *
 * EXIT 0, because nothing went wrong. This is what an idempotent action looks
 * like on its second run, and the line says the wiki already holds what the
 * action would have written — not that the action failed to write it.
 */
function nothingToProposePresentation(
  outcome: Extract<ProductInvokeResultV1, { status: "nothing-to-propose" }>, lines: string[],
): ProductPresentationV1 {
  return {
    lines: [
      ...lines, `run: ${outcome.runId}`,
      `NOTHING TO DO — ${outcome.reason}. No bundle was produced and your wiki is unchanged.`,
    ],
    code: 0, refused: false,
  };
}

/**
 * What a run holding its plan at a review gate prints.
 *
 * NOT a failure and NOT a handoff, and it exits 0 because nothing went wrong:
 * the run is waiting for a person. Printing it as an error would teach an
 * operator to treat their own review step as a problem to route around. Every
 * command it names exists — the decision verb, and the resume that continues
 * this same run.
 */
function awaitingReviewPresentation(
  outcome: Extract<ProductInvokeResultV1, { status: "awaiting-review" }>, lines: string[],
): ProductPresentationV1 {
  const gates = outcome.gateIds.join("|") || "gate";
  return {
    lines: [
      ...lines, `run: ${outcome.runId}`,
      "AWAITING REVIEW — this run reached a review gate and is holding its plan."
      + " Nothing has been proposed or written yet.",
      `read what it found with: llmwiki preparation show ${outcome.runId}`,
      `then decide: llmwiki preparation gate ${outcome.runId} <${gates}> approved|rejected|revised`,
      `and continue with: llmwiki product resume ${outcome.runId} <action token>`,
    ],
    code: 0, refused: false,
  };
}

/** Which of the two verbs this invocation is. */
type ActionMode = "preview" | "invoke";

/** Run one settled request through the service method its mode names. */
async function settleAction(
  root: string, request: ProductInvocationRequestV1, json: boolean, mode: ActionMode,
): Promise<number> {
  if (mode === "preview") {
    const outcome = await cliProductService(root, PREVIEW_GRANTS).preview(request);
    return emitProduct(outcome, json, previewPresentation(outcome));
  }
  const outcome = await cliProductService(root, INVOKE_GRANTS, await cliProviderInvocation()).invoke(request);
  return emitProduct(outcome, json, invokePresentation(outcome));
}

/** The body both verbs share — see the file docblock. */
async function runActionVerb(
  root: string, token: string, options: ProductActionOptions, mode: ActionMode,
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WHOLE VERB in `--json` mode: the run takes the project
  // lock, whose helper prints an advisory line on stdout that would otherwise
  // land ahead of the envelope and break `JSON.parse`.
  return withQuietJson(json, async () => {
    const collected = collectActionInput(options);
    if (collected.status === "refused") {
      return emitProduct(collected, json, refusalPresentation(collected.reason));
    }
    return settleAction(root, {
      workspaceId: options.workspace ?? DEFAULT_PRODUCT_WORKSPACE,
      token, input: collected.input,
    }, json, mode);
  });
}

/**
 * `llmwiki product preview <token>`. Writes no project byte. Returns the exit code.
 *
 * @param root - The project root the invocation acts within.
 * @param token - A canonical action id, or an alias exposed on the CLI surface.
 * @param options - `--input`, `--input-json`, `--workspace`, `--json`.
 */
export async function productPreviewCommand(
  root: string, token: string, options: ProductActionOptions = {},
): Promise<number> {
  return runActionVerb(root, token, options, "preview");
}

/**
 * `llmwiki product invoke <token>`. Stages the compiled action durably and drives
 * it to its Milestone A handoff bundle, which it does NOT apply. Returns the exit
 * code.
 *
 * @param root - The project root the invocation acts within.
 * @param token - A canonical action id, or an alias exposed on the CLI surface.
 * @param options - `--input`, `--input-json`, `--workspace`, `--json`.
 */
export async function productInvokeCommand(
  root: string, token: string, options: ProductActionOptions = {},
): Promise<number> {
  return runActionVerb(root, token, options, "invoke");
}

/**
 * `llmwiki product resume <runId> <token>`. Re-drives a run that suspended at
 * its review gate, after an operator answered it with `preparation gate`.
 *
 * IT TAKES THE TOKEN BECAUSE IT VERIFIES IT. The run's input is read back from
 * its own sealed evidence, never from this call, and the service refuses unless
 * the action the token names recompiles to the plan digest this run was staged
 * against — so naming the wrong action cannot drive someone else's run.
 *
 * @param root - The project root the run belongs to.
 * @param runId - The suspended run, as `invoke` reported it.
 * @param token - The action id or alias the run was invoked through.
 * @param options - `--workspace`, `--json`.
 */
export async function productResumeCommand(
  root: string, runId: string, token: string, options: ProductActionOptions = {},
): Promise<number> {
  const json = options.json === true;
  return withQuietJson(json, async () => {
    const outcome = await cliProductService(root, INVOKE_GRANTS, await cliProviderInvocation()).resume({
      workspaceId: options.workspace ?? DEFAULT_PRODUCT_WORKSPACE, runId, token,
    });
    return emitProduct(outcome, json, invokePresentation(outcome));
  });
}
