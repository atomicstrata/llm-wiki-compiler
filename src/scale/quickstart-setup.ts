/**
 * @file src/scale/quickstart-setup.ts
 * @description The expected-scale step quickstart runs FIRST, before any
 * ingest, fetch or provider check.
 *
 * With `--expected-size`, `--expected-documents` or both it creates the project
 * and sets the estimate exactly as `llmwiki init` does. It then always
 * refuses early when the project is not ready, whether that was just decided
 * or already true. Every SCALE refusal (invalid input, a revision conflict, an
 * unreadable record, a blocked project) is returned as a VALUE, so quickstart
 * reports it through its own versioned failure envelope with a named code;
 * any other failure, such as an I/O error, still propagates.
 */

import { ScaleRefusalError } from "./contracts.js";
import { assertScaleReady, ScaleGateError } from "./gate.js";
import { initProject, parseExpectedScale } from "./init.js";

/** The textual estimate quickstart accepts. */
export interface QuickstartScaleOptions {
  readonly expectedSize?: string;
  readonly expectedDocuments?: string;
}

/** Why quickstart must stop before ingest, in the shapes of its envelope: the ingest error and the next action. */
export interface ScaleSetupFailure {
  readonly error: { code: string; message: string; recoverable: boolean };
  readonly next: { command: string; reason: string; executable: { binary: "llmwiki"; args: string[]; placeholders: string[] } };
}

/** The failure for a named scale code: nothing was ingested; inspect the expected scale next. */
function failure(code: string, message: string): ScaleSetupFailure {
  return {
    error: { code, message, recoverable: true },
    next: {
      command: "llmwiki scale status",
      reason: "The project's expected scale is not ready. Inspect it, then prepare or lower it.",
      executable: { binary: "llmwiki", args: ["scale", "status"], placeholders: [] },
    },
  };
}

/** Run the scale step for the project at `root`; `null` means quickstart may proceed. */
export async function quickstartScaleSetup(root: string, options: QuickstartScaleOptions): Promise<ScaleSetupFailure | null> {
  try {
    const request = parseExpectedScale(options.expectedSize, options.expectedDocuments);
    if (request !== undefined) await initProject(root, request);
    await assertScaleReady(root);
    return null;
  } catch (error) {
    if (error instanceof ScaleRefusalError) return failure(error.code, error.message);
    if (error instanceof ScaleGateError) return failure(error.block, error.message);
    throw error;
  }
}
