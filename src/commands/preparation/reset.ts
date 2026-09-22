/**
 * @file src/commands/preparation/reset.ts
 * @description `llmwiki preparation reset` — the operator surface for repairing
 * a project whose preparation key is missing or unreadable.
 *
 * AN ADAPTER, and nothing else (D-10-1). The two-pass protocol, the destructive
 * confirmation, the continuation authentication and the CLI-only enforcement all
 * live below; what remains here is how four answers read and which flags name
 * which arm.
 *
 * ONE VERB, THREE ARMS, and the alternative was three verbs. The service's
 * operation set is closed and counted — the aggregate contract gate asserts a
 * correspondence between it and what the surfaces expose — so splitting the
 * arms into `reset`, `reset-continue` and `reset-supersede` would report three
 * operations where the table has one. The arms are flags on one verb because
 * they ARE one operation: the substrate decides between them from the same
 * request, under the same lock, with the same confirmation.
 *
 * WHY THIS VERB EXISTS AT ALL. Before it, the approved operator runbook for a
 * project whose key is gone ended by telling its reader to call internal
 * functions from a harness that does not exist. Steps 1-6 of that procedure are
 * irreversible filesystem work and step 7 was unreachable, so an operator who
 * followed it was left worse off than when they started. This is step 7.
 *
 * `--supersede` IS NOT A CONVENIENCE. Pass one records a durable intent marker,
 * and while one is pending NOTHING in the project can acquire the mutation lock:
 * ordinary work refuses because a unit is pending, and every other destructive
 * operation refuses because that unit is a reset holding custody. An operator
 * who loses the continuation secret has exactly one exit and this flag is it.
 * Shipping the verb without it would ship the wedge.
 *
 * THE CONTINUATION SECRET IS PRINTED, and there is no way around it. Pass two
 * cannot be authorized without it, so pass one must hand it to the operator; the
 * substrate mints it and returns it for that reason.
 *
 * SO THE LIMIT IS TOLD TO THE OPERATOR, not only to whoever reads this file. The
 * exposure is theirs to carry, and a limit recorded only in source is one the
 * exposed person never reads — so pass one prints it beside the secret, and
 * `--help` carries it too. Two parts, and only one of them is avoidable:
 *
 *  - IT LANDS IN SCROLLBACK AND IN ANY `--json` CAPTURE. Unavoidable: the
 *    protocol has to hand it over, and pass one is the only place it exists.
 *  - ON PASS TWO IT IS AN ARGUMENT, so `ps` shows it to every user on the box
 *    for the life of the process. AVOIDABLE, and `LLMWIKI_PREP_RESET_TOKEN` is
 *    the way around it — an environment variable is not in the process's
 *    argument vector.
 *
 * No prompt and no stdin path is built. Either would narrow the second exposure
 * that the environment variable already narrows, and neither touches the first.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { ResetResultV1 } from "../../preparations/service.js";
import {
  FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION,
} from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/**
 * What `--confirm` expects, named in full.
 *
 * AN EMERGENCY TOOL THAT CANNOT BE FIGURED OUT IS A DEFECT, and this verb was
 * measured being one: with `--confirm` absent, the substrate answered "reset of
 * a missing-key key requires its distinct confirmation" — naming neither phrase
 * — and `--help` named neither either. An operator whose project key is gone had
 * no route to the string except reading source. The phrases come from the
 * service rather than being spelled out here, so the tool cannot advertise one
 * the substrate stopped accepting.
 */
/**
 * The environment variable pass two reads the continuation secret from.
 *
 * `LLMWIKI_PREP_` matches the preparation family's existing variables.
 */
const RESET_TOKEN_ENV = "LLMWIKI_PREP_RESET_TOKEN";

export const RESET_TOKEN_DESCRIPTION =
  `The continuation secret the first pass returned. Prefer ${RESET_TOKEN_ENV} in `
  + "the environment: a flag is visible to `ps` for other users on shared machines";

export const RESET_CONFIRM_DESCRIPTION =
  "The destructive confirmation this reset requires: "
  + `'${MISSING_KEY_CONFIRMATION}' when the key is absent, `
  + `'${FORCED_KEY_CONFIRMATION}' when it is present but unreadable`;

/**
 * The refusal for a `reset` invoked with no confirmation at all.
 *
 * REFUSED AT THE SURFACE, and this is the one precondition the adapter may
 * answer without the substrate: "you supplied no phrase" needs no knowledge of
 * the key state, whereas "you supplied the WRONG phrase" does and stays below.
 * The message names both, because which one applies depends on a key state the
 * operator is often not sure of — that uncertainty is why they are here.
 */
const MISSING_CONFIRMATION_REFUSAL =
  "reset needs an explicit destructive confirmation: pass --confirm "
  + `'${MISSING_KEY_CONFIRMATION}' if the preparation key is absent, or --confirm `
  + `'${FORCED_KEY_CONFIRMATION}' if it is present but unreadable`;

/** CLI options for `preparation reset`. */
export interface PreparationResetOptions {
  /** The reason-specific destructive confirmation phrase. */
  confirm?: string;
  /** Pass two: the `rst-…` unit pass one reported. */
  continue?: string;
  /** Pass two: the continuation secret pass one returned. */
  token?: string;
  // NOTE: the secret may instead arrive in `LLMWIKI_PREP_RESET_TOKEN`, which is
  // the route that keeps it out of `ps`. See `continuationToken`.
  /** Clear provably intent-only reset markers whose secret is lost. */
  supersede?: boolean;
  /** Emit the machine-readable envelope instead of the human lines. */
  json?: boolean;
}

/** The one wording for a continuation missing half of its pair. */
const HALF_CONTINUATION_REFUSAL =
  "continuing a reset needs the unit and the secret together: --continue <unitId> "
  + `with either --token <secret> or ${RESET_TOKEN_ENV} in the environment`;

/** Whether exactly one half of the continuation pair was supplied. */
function halfSupplied(unitId: string | undefined, token: string | undefined): boolean {
  return (unitId === undefined) !== (token === undefined);
}

/**
 * The continuation secret, from the flag or from the environment.
 *
 * THE ENVIRONMENT IS THE PRIVATE ROUTE, and it is the only one of the secret's
 * two exposures that can be closed. A flag lands in the process's argument
 * vector, which `ps` shows to every user on the box for the life of the process;
 * an environment variable does not. It cannot help with the other exposure —
 * pass one has to PRINT the secret, because that is the only place it exists —
 * so this narrows the avoidable half and leaves the unavoidable half stated.
 *
 * THE FLAG WINS when both are present, because an operator who typed something
 * explicitly meant it, and a stale exported variable silently overriding a typed
 * argument is the surprise worth avoiding.
 */
function continuationToken(options: PreparationResetOptions): string | undefined {
  const supplied = options.token ?? process.env[RESET_TOKEN_ENV];
  // An EMPTY variable is not a secret. Treated as absent so an exported-but-unset
  // `LLMWIKI_PREP_RESET_TOKEN` earns the half-supplied refusal, which names both
  // routes, rather than a `continuation-mismatch` about a malformed token.
  return supplied === undefined || supplied === "" ? undefined : supplied;
}

/**
 * The unit and secret pass two needs, or the refusal for a half-supplied pair.
 *
 * BOTH OR NEITHER, checked here rather than left to the substrate. The unit id
 * is not derivable: `openContinuation` addresses the named unit DIRECTLY and
 * refuses to search for one whose digest matches, precisely so a copy of a
 * legitimate intent parked under another unit cannot capture the operator's
 * token. Accepting `--token` alone would mean either reintroducing that search
 * or refusing with a message about a flag the operator did not use.
 */
function continuationFrom(
  options: PreparationResetOptions,
): { readonly ok: true; readonly continuation?: { unitId: string; token: string } }
  | { readonly ok: false; readonly reason: string } {
  const unitId = options.continue;
  const token = continuationToken(options);
  if (halfSupplied(unitId, token)) return { ok: false, reason: HALF_CONTINUATION_REFUSAL };
  return unitId === undefined || token === undefined
    ? { ok: true }
    : { ok: true, continuation: { unitId, token } };
}

/** The human lines for a recorded first-pass intent. */
function recordedLines(outcome: Extract<ResetResultV1, { status: "intent-recorded" }>): void {
  output.status("✓", output.info(
    `reset intent recorded for a ${outcome.reason} key (unit ${outcome.unitId})`));
  // SHOWN ONCE, and said so. The secret is not stored anywhere an operator can
  // read it back — only its digest is durable — so an operator who closes the
  // terminal without copying it needs `--supersede` and a second first pass.
  output.status("!", output.warn(
    `continuation secret (shown once): ${outcome.continuationToken}`));
  output.status("→", output.info(
    `complete with: llmwiki preparation reset --confirm <phrase> `
    + `--continue ${outcome.unitId} --token <secret>`));
  // THE LIMIT, TOLD TO THE PERSON WHO CARRIES IT. The operator is the one
  // exposed by this secret, and a limit recorded only in a source docblock is
  // one they never read. Both halves are named, and so is the way around the
  // half that has one.
  output.status("i", output.info(
    `this secret is now in your scrollback and in any --json capture; on the `
    + `second pass, prefer ${RESET_TOKEN_ENV} in the environment over --token, `
    + `which \`ps\` exposes to other users on shared machines`));
}

/** The human lines for one outcome. */
function humanLines(outcome: ResetResultV1): void {
  if (outcome.status === "refused") {
    output.status("!", output.warn(outcome.reason));
    return;
  }
  if (outcome.status === "intent-recorded") {
    recordedLines(outcome);
    return;
  }
  output.status("✓", output.info(outcome.status === "completed"
    ? `preparation key epoch reset (unit ${outcome.unitId}, epoch ${outcome.keyEpochId})`
    : `superseded ${outcome.unitIds.length} pending reset intent(s): ${outcome.unitIds.join(", ")}`));
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: ResetResultV1, json: boolean): void {
  if (json) {
    emitJson(outcome);
    return;
  }
  humanLines(outcome);
}

/** `llmwiki preparation reset`. Returns the process exit code. */
export async function preparationResetCommand(
  root: string, options: PreparationResetOptions = {},
): Promise<number> {
  const json = options.json === true;
  const confirmation = options.confirm;
  if (confirmation === undefined) {
    report({ status: "refused", reason: MISSING_CONFIRMATION_REFUSAL }, json);
    return 1;
  }
  const opened = continuationFrom(options);
  if (!opened.ok) {
    report({ status: "refused", reason: opened.reason }, json);
    return 1;
  }
  const outcome = await withQuietJson(json, () => cliPreparationService(root).reset({
    // Passed through EXACTLY as typed. A phrase that is present but WRONG is the
    // substrate's call, not this adapter's: which one is required depends on the
    // real key state, read under the lock. Only the absent case is answered
    // above, and only because it needs no knowledge of that state.
    confirmation,
    ...(opened.continuation === undefined ? {} : { continuation: opened.continuation }),
    ...(options.supersede === undefined ? {} : { supersede: options.supersede }),
  }));
  report(outcome, json);
  return outcome.status === "refused" ? 1 : 0;
}
