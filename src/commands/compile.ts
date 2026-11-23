/**
 * Commander action for `llmwiki compile`.
 * Checks that sources exist, then delegates to the compilation orchestrator
 * to process all new and changed source files into wiki pages. Also serves
 * `compile --report <runId>`: one read-only page of a batch run's report.
 */

import type { BatchRunOptions } from "../compiler/batch/contracts.js";
import { readReport } from "../compiler/batch/report.js";
import { compile } from "../compiler/index.js";
import { locationExistsSync } from "../storage/disk-locations.js";
import * as output from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { CompileOptions } from "../utils/types.js";

/**
 * Run the compile command from the current working directory.
 * Exits early if no sources directory exists yet.
 * @param options - Optional behaviour overrides forwarded from the CLI flag set.
 */
export default async function compileCommand(options: CompileOptions & BatchRunOptions = {}): Promise<void> {
  if (!locationExistsSync(SOURCES_DIR)) {
    output.status(
      "!",
      output.warn('No sources found. Run `llmwiki ingest <url>` first.'),
    );
    return;
  }

  await compile(process.cwd(), options);
}

/**
 * Print one page of batch run `runId`'s report (of the project in the current
 * directory) as JSON on stdout; continue with the printed `cursor`.
 * @param runId - The run id a batch compile printed.
 * @param cursor - The cursor of the previous page, if any.
 */
export async function compileReportCommand(runId: string, cursor?: string): Promise<void> {
  console.log(JSON.stringify(await readReport(process.cwd(), runId, cursor), null, 2));
}
