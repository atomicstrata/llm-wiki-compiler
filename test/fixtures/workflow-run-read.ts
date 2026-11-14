/**
 * @file test/fixtures/workflow-run-read.ts
 * @description Read a persisted workflow run back in a test and fail unless it
 * parses as `ok`.
 *
 * Kept apart from `workflow-profile.ts` (pure profile data) and
 * `workflow-run-helpers.ts` (start/advance preambles): it loads only the run
 * history store, so a test that just re-reads runs does not load the workflow engine or
 * the SDK. Bun loads every test file's import graph afresh, so each fixture
 * module costs every file that imports it.
 */

import { readRun } from "../../src/workflow-history/store.js";
import type { WorkflowRun } from "../../src/workflows/types.js";

/**
 * Re-read a persisted run, failing the test (throwing) if it is not `ok`. Shared so
 * the workflow tests don't each re-declare the same read-and-assert-ok helper.
 *
 * @param root - Absolute project root.
 * @param runId - The run id to re-read.
 * @returns The validated run record.
 */
export async function readOkRun(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}
