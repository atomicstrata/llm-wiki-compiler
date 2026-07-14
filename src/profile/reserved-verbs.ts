/**
 * Reserved top-level CLI command verbs.
 *
 * A profile-declared workflow id is surfaced in command space by a later slice,
 * so it MUST NOT collide with one of the system's own top-level CLI verbs — a
 * collision would shadow or be confused with a core command. This module is the
 * single source of that reserved set, imported by the profile validator and
 * kept in sync with the Commander command registry in `src/cli.ts`.
 *
 * The set is kept deliberately small, frozen, and sorted so it is easy to audit
 * against the live command registry. KEEP THIS IN SYNC with the top-level CLI
 * verbs registered in `src/cli.ts`: `test/reserved-verbs-drift.test.ts` parses
 * the live `--help` registry and fails if any registered verb is missing here,
 * so adding a new top-level command requires adding its verb to this set.
 */

/** The reserved set described in the file header. Sorted, frozen. */
export const RESERVED_CORE_VERBS: ReadonlySet<string> = new Set([
  "artifact", "cache", "compile", "connector", "context", "eval", "export", "import",
  "ingest", "ingest-session", "lint", "next", "profile", "query",
  "quickstart", "recover", "refresh", "review", "rules", "schema", "serve",
  "state", "status", "template", "view", "watch", "workflow",
]);
