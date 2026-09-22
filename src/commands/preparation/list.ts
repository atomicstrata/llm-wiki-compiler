/**
 * @file src/commands/preparation/list.ts
 * @description `llmwiki preparation list` — enumerate preparation runs and the
 * lifecycle problems observed while reading them.
 *
 * AN ADAPTER, and nothing else (D-10-1). Every decision about what a listing IS
 * — the could-not-see taxonomy, the run-accounting cross-check, the key-failure
 * branch — lives in the service, so a second surface answers the same question
 * the same way instead of re-deriving it. What is left here is the operator's
 * view of that answer: a table, or the machine envelope.
 *
 * Read-only: it takes no lock and writes no byte. It exits 0 on a successful
 * inspection — observed problems are REPORTED, not signalled through the exit
 * code, matching `operation list`, because "I read the store and it has
 * problems" is a successful read.
 */

import * as output from "../../utils/output.js";
import { emitJson } from "../operation/render.js";
import type { ListResultV1, PreparationRunRowV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation list`. */
export interface PreparationListOptions {
  /** Emit the machine-readable envelope instead of the human table. */
  json?: boolean;
}

/** One human-readable run line. */
function rowLine(row: PreparationRunRowV1): string {
  const state = row.state ?? `unreadable (${row.detail ?? "unknown"})`;
  return `${row.runId}  prep=${row.preparationId}  ws=${row.workspaceId}  state=${state}`;
}

/** Print the human table. */
function printTable(listing: ListResultV1): void {
  // `output.status` PRINTS; `info`/`warn` only format. The first version called
  // the formatters alone and printed nothing at all — caught by the subprocess
  // test, which is exactly the class of defect an in-process test cannot see.
  // Problems FIRST, matching the precedent: a reader who stops after the first
  // line should see the caveat, not the summary it qualifies.
  for (const problem of listing.problems) {
    output.status("!", output.warn(`problem: ${problem}`));
  }
  if (listing.runs.length === 0) {
    output.status("i", output.info("No preparation runs."));
  }
  for (const row of listing.runs) {
    output.status("~", output.info(rowLine(row)));
  }
  printCaps(listing);
}

/**
 * Say what the response cap left out.
 *
 * The cap is only honest if the human surface says so too — a silently short
 * table is the same defect as a silently empty one.
 */
function printCaps(listing: ListResultV1): void {
  if (listing.truncated) {
    output.status("i", output.info(
      `Showing ${listing.runs.length} of ${listing.total} runs; the response is capped.`));
  }
  if (listing.problemsTruncated) {
    output.status("!", output.warn(
      `Showing ${listing.problems.length} of ${listing.problemTotal} problems; the response is capped.`));
  }
}

/** `llmwiki preparation list`. Returns the process exit code. */
export async function preparationListCommand(
  root: string, options: PreparationListOptions = {},
): Promise<number> {
  const service = cliPreparationService(root);
  // QUIET AROUND THE READ, as `operation list` does. Without it any
  // `output.status` on the read path — a scan note, a progress line — lands on
  // stdout ahead of the envelope and `JSON.parse` fails. Nothing prints there
  // today, which is exactly why the guard has to be in place before something
  // does; the break would be invisible to a suite whose stores are all empty.
  if (options.json === true) {
    output.setQuiet(true);
    try {
      // THE WHOLE LISTING, not a two-field projection. The response is bounded
      // (design v10 §6), so a consumer that cannot see `total` / `truncated`
      // cannot tell a hundred-run store from a complete one.
      emitJson(await service.list());
    } finally {
      output.setQuiet(false);
    }
    return 0;
  }
  printTable(await service.list());
  return 0;
}
