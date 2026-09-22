/**
 * @file src/commands/preparation/cancel.ts
 * @description `llmwiki preparation cancel <runId>` — request cancellation of
 * one preparation run.
 *
 * AN ADAPTER, and nothing else (D-10-1). The lock-free publication, the
 * could-not-see refusal taxonomy, the terminal precondition and the
 * collision classification all live in the service; what remains here is the run
 * id the operator typed and the three ways they can be answered.
 *
 * IT TAKES NO `--force` AND NO `--requester`. The requester recorded on the
 * request is the host-assigned principal, so there is no flag through which an
 * operator can present a different identity — the same rule that keeps an actor
 * out of every other preparation request.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { CancelResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation cancel`. */
export interface PreparationCancelOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/** The human line for one published or already-pending request. */
function requestedLine(outcome: Extract<CancelResultV1, { status: "requested" }>): string {
  return outcome.request === "created"
    ? `${outcome.runId} cancellation requested`
    : `${outcome.runId} already has a pending cancellation request`;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: CancelResultV1, json: boolean): void {
  if (json) {
    // `emitJson` writes RAW to stdout; `output.status` prefixes an icon, which
    // is what stopped the sibling verbs' envelopes from ever parsing.
    emitJson(outcome);
    return;
  }
  if (outcome.status === "requested") {
    output.status("✓", output.info(requestedLine(outcome)));
    return;
  }
  output.status("!", output.warn(outcome.reason));
}

/** `llmwiki preparation cancel <runId>`. Returns the process exit code. */
export async function preparationCancelCommand(
  root: string, runId: string, options: PreparationCancelOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WORK, through the one shared scope: without it a helper's
  // advisory line lands on stdout ahead of the envelope and `JSON.parse` fails.
  const outcome = await withQuietJson(json, () => cliPreparationService(root).cancel({ runId }));
  report(outcome, json);
  // ALREADY-PENDING IS A SUCCESS. The operator's intent is on disk either way,
  // and a nonzero exit for an idempotent retry would make a re-run of a script
  // look like a failure.
  return outcome.status === "requested" ? 0 : 1;
}
