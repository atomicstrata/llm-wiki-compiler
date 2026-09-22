/**
 * @file src/commands/preparation/gate.ts
 * @description `llmwiki preparation gate <runId> <gateId> <decision>` — record
 * one host-authored gate decision on a preparation run.
 *
 * AN ADAPTER, and nothing else (D-10-1). The closed decision vocabulary, the
 * per-kind grant, the recomputed bound digests, the derived decision index and
 * the atomic transition-plus-projection write all live in the service; what
 * remains here is the three values the operator typed and the two ways they can
 * be answered.
 *
 * THE DECISION IS A POSITIONAL ARGUMENT, NOT A FLAG. `--approve` alongside
 * `--reject` is two flags that can both be set and neither can, which is a third
 * and fourth state nobody chose. One argument checked against one closed set has
 * neither.
 *
 * THERE IS NO `--gate-kind` AND NO `--phase`. The gate KIND selects which of
 * three grants the decision costs, and the phase instance is one of the digests
 * the proof binds; both are read from the run's own authenticated plan and run.
 * An operator flag for either would be a caller-presented fact becoming durable
 * authority — the same rule that keeps an actor out of every preparation request.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { GateDecision, GateResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation gate`. */
export interface PreparationGateOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
  /** A bounded reason code recorded on the proof. */
  reason?: string;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: GateResultV1, json: boolean): void {
  if (json) {
    // `emitJson` writes RAW to stdout; `output.status` prefixes an icon, which
    // is what stopped the sibling verbs' envelopes from ever parsing.
    emitJson(outcome);
    return;
  }
  if (outcome.status === "recorded") {
    output.status("✓", output.info(
      `${outcome.runId} gate ${outcome.gateId} recorded ${outcome.decision} `
      + `(decision ${outcome.decisionIndex}, proof ${outcome.gateProofId})`));
    return;
  }
  output.status("!", output.warn(outcome.reason));
}

/** `llmwiki preparation gate <runId> <gateId> <decision>`. Returns the exit code. */
export async function preparationGateCommand(
  root: string, runId: string, gateId: string, decision: string,
  options: PreparationGateOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WORK, through the one shared scope: without it a helper's
  // advisory line lands on stdout ahead of the envelope and `JSON.parse` fails.
  const outcome = await withQuietJson(json, () => cliPreparationService(root).gate({
    runId, gateId,
    // Handed over UNVALIDATED, deliberately. The service checks it against the
    // one closed decision vocabulary; a second check here would be a check that
    // can disagree with its executor, and the operator would get whichever
    // message happened to fire first.
    decision: decision as GateDecision,
    ...(options.reason === undefined ? {} : { reasonCode: options.reason }),
  }));
  report(outcome, json);
  return outcome.status === "recorded" ? 0 : 1;
}
