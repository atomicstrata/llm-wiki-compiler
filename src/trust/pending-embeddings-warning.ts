/**
 * @file src/trust/pending-embeddings-warning.ts
 * @description The read-only mapper that SURFACES the durable pending-embedding
 * refresh marker (`.llmwiki/pending-embeddings.json`) as a neutral
 * `{ code, message }` warning — so a compile that ran with no embedding provider /
 * API key (or hit a failure) and SWALLOWED the embeddings refresh is no longer
 * invisible. Without this, the only signal is PR4's per-query degrade-on-read, and
 * the "just re-run `llmwiki compile`" remedy is undiscoverable; this turns the
 * on-disk marker into an actionable status/lint signal, MIRRORING
 * {@link journalHealthWarning} exactly.
 *
 * Like the journal mapper, this is purely a read — it never writes, drains, or
 * creates `.llmwiki`. It defers to {@link readPendingMarker}, which uses the
 * no-mkdir confined resolver and distinguishes ABSENT (clean) from UNAVAILABLE
 * (a marker that exists but cannot be trusted — escaping/symlinked/oversize/corrupt).
 * An ABSENT or empty marker → `null`, which adds NOTHING, so a clean project's every
 * read surface stays byte-identical (parity-safe). An UNAVAILABLE marker is no
 * longer reported as clean: it surfaces {@link PENDING_EMBEDDINGS_UNAVAILABLE_CODE}
 * (fail closed VISIBLY, never silently as empty).
 */

import { readPendingMarker } from "../utils/pending-embeddings.js";
import type { ReadSurfaceWarning } from "./journal-health-warning.js";

/** Stable warning code for pending (un-refreshed) embeddings awaiting retry. */
export const PENDING_EMBEDDINGS_PENDING_CODE = "embeddings-refresh-pending" as const;

/** Stable warning code for an UNREADABLE/untrustworthy recovery marker. */
export const PENDING_EMBEDDINGS_UNAVAILABLE_CODE = "embeddings-refresh-unavailable" as const;

/** Human-readable copy for the pending-embeddings warning, naming the count. */
function pendingMessage(count: number): string {
  return (
    `${count} page(s) awaiting embedding refresh — configure an embedding provider ` +
    "and re-run `llmwiki compile` to refresh semantic search."
  );
}

/** Human-readable copy for the unreadable-marker warning, naming the failure reason. */
function unavailableMessage(detail: string): string {
  return (
    `The pending-embedding recovery marker (.llmwiki/pending-embeddings.json) is unreadable ` +
    `(${detail}); pending refreshes may be lost — re-run \`llmwiki compile\` after removing or fixing it.`
  );
}

/**
 * Resolve the project's pending-embedding marker and map it to a neutral warning, or
 * `null` when nothing needs attention. Read-only: defers entirely to
 * {@link readPendingMarker} (no-mkdir resolver). An `absent` marker (a clean project,
 * no `.llmwiki`) and an `ok`-but-empty marker both → `null`, creating nothing — what
 * keeps a clean project's read surfaces byte-identical. An `ok` non-empty marker →
 * the `embeddings-refresh-pending` count warning; an `unavailable` marker (exists but
 * untrustworthy) → the `embeddings-refresh-unavailable` warning so silent
 * recovery-data loss is surfaced.
 *
 * @param root - Absolute project root whose marker is inspected.
 * @returns The pending-embeddings warning, or `null` when nothing needs attention.
 */
export async function pendingEmbeddingsWarning(root: string): Promise<ReadSurfaceWarning | null> {
  const marker = await readPendingMarker(root);
  if (marker.status === "unavailable") {
    return {
      code: PENDING_EMBEDDINGS_UNAVAILABLE_CODE,
      message: unavailableMessage(marker.detail ?? "unreadable"),
    };
  }
  if (marker.status === "absent" || marker.entries.length === 0) return null;
  return { code: PENDING_EMBEDDINGS_PENDING_CODE, message: pendingMessage(marker.entries.length) };
}
