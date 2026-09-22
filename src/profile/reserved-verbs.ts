/**
 * Profile-schema reservations and the live top-level CLI command inventory.
 *
 * Schema-v1 reservations are stable: extending the CLI must not invalidate an
 * existing profile. Workflow and action IDs are positional arguments beneath
 * `workflow`, not dynamically registered top-level commands. The CLI inventory
 * is separate and checked against actual help output by the drift test.
 */

/** Names excluded by the public profile-v1 contract; do not expand in place. */
export const PROFILE_V1_RESERVED_VERBS: ReadonlySet<string> = new Set([
  "artifact", "cache", "compile", "connector", "context", "eval", "export", "import",
  "ingest", "ingest-session", "lint", "next", "profile", "query",
  "quickstart", "recover", "refresh", "review", "rm", "rules", "schema", "serve",
  "state", "status", "template", "view", "watch", "workflow",
]);

/** Live CLI inventory, independent of persisted profile-v1 validation. */
export const RESERVED_CORE_VERBS: ReadonlySet<string> = new Set([
  ...PROFILE_V1_RESERVED_VERBS, "operation", "preparation", "product", "visualize",
]);
