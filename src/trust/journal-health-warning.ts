/**
 * @file src/trust/journal-health-warning.ts
 * @description The SHARED read-surface mapper for journal health. Every
 * content-exposing read surface (status, lint, viewer snapshot, JSON export,
 * SDK list/search/context) must SURFACE a `pending`/`unavailable` journal so an
 * agent or user is never silently served partial post-crash state. This module
 * owns the one place that turns the read-only {@link journalHealth} verdict into
 * a neutral `{ code, message }` warning, and each surface threads it through its
 * OWN existing warning channel (mirroring how `relation-store-unavailable` /
 * `embedding-index-outdated` are surfaced):
 *  - `pending`     → `incomplete-compile` ("a prior compile did not finish");
 *  - `unavailable` → `journal-unavailable` (a distinct tamper/corruption signal);
 *  - `ok`          → `null` (adds NOTHING, so a clean project stays byte-identical).
 *
 * Like {@link journalHealth}, this is purely a read — it never writes, replays,
 * prunes, locks, or creates `.llmwiki`. Threading it into a read surface must
 * keep that surface read-only.
 */

import { journalHealth } from "./journal-health.js";

/** Stable warning code for a `pending` journal (an incomplete compile to recover). */
export const INCOMPLETE_COMPILE_CODE = "incomplete-compile" as const;

/** Stable warning code for an `unavailable` journal (tampered/corrupt — distinct from pending). */
export const JOURNAL_UNAVAILABLE_CODE = "journal-unavailable" as const;

/** The two journal-health warning codes a read surface may surface. */
export type JournalWarningCode =
  | typeof INCOMPLETE_COMPILE_CODE
  | typeof JOURNAL_UNAVAILABLE_CODE;

/** Human-readable copy for the `pending` (incomplete-compile) warning. */
const INCOMPLETE_COMPILE_MESSAGE =
  "A prior compile did not finish; run `llmwiki compile` to recover. " +
  "The wiki may reflect partial, post-crash state.";

/** Human-readable copy for the `unavailable` (journal-unavailable) warning. */
const JOURNAL_UNAVAILABLE_MESSAGE =
  "The compile journal is unavailable (corrupt, unreadable, or escaping the " +
  "project root); content may be partial or tampered. Run `llmwiki compile` to recover.";

/**
 * A neutral read-surface warning: a stable, scriptable `code` plus a
 * human-readable `message`. The SHARED element type every read surface's
 * `warnings[]` channel carries, so independent signals (journal health,
 * pending-embedding refresh) coexist in one array. {@link JournalWarning}
 * narrows `code` to the journal codes; other mappers (e.g.
 * `pendingEmbeddingsWarning`) emit their own `code` under this same shape.
 */
export interface ReadSurfaceWarning {
  code: string;
  message: string;
}

/** A neutral journal-health warning: a journal code plus human-readable message. */
export interface JournalWarning extends ReadSurfaceWarning {
  code: JournalWarningCode;
}

/**
 * Resolve the project's journal health and map it to a neutral warning, or
 * `null` when the journal is `ok`. Read-only: defers entirely to
 * {@link journalHealth}, which never mutates the filesystem (no write, replay,
 * prune, lock, or `.llmwiki` mkdir). The `ok` → `null` mapping is what keeps a
 * clean project's every read surface byte-identical.
 *
 * @param root - Absolute project root whose journal is inspected.
 * @returns The journal warning, or `null` when the journal is healthy.
 */
export async function journalHealthWarning(root: string): Promise<JournalWarning | null> {
  const { status } = await journalHealth(root);
  if (status === "pending") {
    return { code: INCOMPLETE_COMPILE_CODE, message: INCOMPLETE_COMPILE_MESSAGE };
  }
  if (status === "unavailable") {
    return { code: JOURNAL_UNAVAILABLE_CODE, message: JOURNAL_UNAVAILABLE_MESSAGE };
  }
  return null;
}
