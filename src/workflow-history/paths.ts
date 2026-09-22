/**
 * @file src/workflow-history/paths.ts
 * @description Shared run path grammar; no filesystem access.
 */
import path from "node:path";
import { isSlugSafe } from "../profile/identity.js";
/**
 * Hard upper bound on a run id's length. The shared {@link isSlugSafe} grammar
 * caps charset but NOT length, so a multi-thousand-char all-lowercase id passes
 * it and then dies with a generic `ENAMETOOLONG` deep inside `writeRun`. This
 * store-local bound rejects an over-long id with a TYPED outcome (write →
 * {@link WorkflowRunIdError}; read → `unavailable`) BEFORE any fs call. 128 is far
 * above a minted id (`<workflowId>-<YYYY-MM-DD>-<rand4>`) yet well under any
 * filesystem `NAME_MAX`. `isSlugSafe` is left untouched (it is shared across many
 * surfaces); the length bound lives only where filenames are minted.
 */
const MAX_RUN_ID_LENGTH = 128;


/** True only when `runId` is slug-safe AND within {@link MAX_RUN_ID_LENGTH}. */
export function isValidRunId(runId: string): boolean {
  return runId.length <= MAX_RUN_ID_LENGTH && isSlugSafe(runId);
}


/** Subdirectory under `.llmwiki` holding per-run record files. */
const RUNS_SUBDIR = ["workflows", "runs"] as const;


/** The `workflows/runs` directory inside an already-confined private dir. */
export function runsDirFor(privateDir: string): string {
  return path.join(privateDir, ...RUNS_SUBDIR);
}
