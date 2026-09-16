/**
 * Persistent, read-only diagnostics for embedding refreshes stopped at the retry
 * limit. Includes exhausted entries retained in pending when quarantine is full;
 * deduplicates interrupted settlements and uses the same confined marker reader
 * as retry processing. Never repairs, requeues, or creates project files.
 */
import { readPendingMarker } from "../utils/pending-embeddings.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../utils/constants.js";
import type { ReadSurfaceWarning } from "./journal-health-warning.js";

/** The marker location lets lint identify pending overflow without naming an absent file. */
interface QuarantineWarning extends ReadSurfaceWarning {
  file: string;
}

/** Surface stopped retries or unreadable quarantine data, without provider calls or writes. */
export async function quarantinedEmbeddingsWarning(root: string): Promise<QuarantineWarning | null> {
  const [quarantine, pending] = await Promise.all([
    readPendingMarker(root, QUARANTINED_EMBEDDINGS_FILE),
    readPendingMarker(root),
  ]);
  if (quarantine.status === "unavailable") {
    return {
      code: "embeddings-quarantine-unavailable",
      file: QUARANTINED_EMBEDDINGS_FILE,
      message: `The embedding quarantine marker (${QUARANTINED_EMBEDDINGS_FILE}) is unreadable ` +
        `(${quarantine.detail ?? "unreadable"}); stopped retries cannot be verified. ` +
        "Inspect or restore the marker before compiling; removing it resets retry exclusions and may incur costs.",
    };
  }
  const held = pending.entries.filter(entry => entry.attempts >= MAX_PENDING_EMBEDDING_ATTEMPTS);
  const ids = new Set([...quarantine.entries, ...held].map(entry => entry.pageId));
  if (ids.size === 0) return null;
  return {
    code: "embeddings-refresh-quarantined",
    file: quarantine.entries.length > 0 ? QUARANTINED_EMBEDDINGS_FILE : PENDING_EMBEDDINGS_FILE,
    message: `${ids.size} page(s) have stopped embedding refreshes after repeated failures; semantic search may be incomplete. ` +
      `Inspect ${QUARANTINED_EMBEDDINGS_FILE} and exhausted entries in ${PENDING_EMBEDDINGS_FILE}. ` +
      "Fix the provider or page, then edit its source and compile, or re-save the page, to retry. " +
      "An unchanged compile does not reset their retry budgets.",
  };
}
