/**
 * @file src/linter/pending-embeddings-rule.ts
 * @description The `pending-embeddings` lint rule. SURFACES the durable
 * pending-embedding refresh marker as a lint `warning`, so `llmwiki lint` (and the
 * `lint_wiki` MCP tool / SDK `lint`) reports when a compile skipped/failed its
 * embeddings refresh — making the otherwise-invisible "N pages have stale
 * embeddings pending retry" state discoverable and the "re-run compile" remedy
 * actionable. Threads the SHARED read-only {@link pendingEmbeddingsWarning} mapper
 * into the linter's existing `LintResult` channel, MIRRORING `checkJournalHealth`.
 * Read-only: emits a diagnostic only, never drains the marker.
 *
 * An empty marker (the default) yields zero findings, so the default lint output
 * stays byte-identical (parity-safe).
 */

import { pendingEmbeddingsWarning } from "../trust/pending-embeddings-warning.js";
import { PENDING_EMBEDDINGS_FILE } from "../utils/constants.js";
import type { LintResult } from "./types.js";

/**
 * Emit a `pending-embeddings` warning when the durable refresh marker is
 * non-empty. The finding's `message` is prefixed with the stable warning code
 * (`embeddings-refresh-pending`) so scripted consumers can branch on it without
 * parsing the human-readable tail.
 *
 * @param root - Absolute path to the project root directory.
 * @returns A single-element result list when pending; empty when nothing is pending.
 */
export async function checkPendingEmbeddings(root: string): Promise<LintResult[]> {
  const warning = await pendingEmbeddingsWarning(root);
  if (warning === null) return [];
  return [
    {
      rule: "pending-embeddings",
      severity: "warning",
      file: PENDING_EMBEDDINGS_FILE,
      message: `${warning.code}: ${warning.message}`,
    },
  ];
}
