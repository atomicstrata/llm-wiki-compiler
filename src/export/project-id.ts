/**
 * Project ID validation for the JSON export contract.
 *
 * The regex `PROJECT_ID_PATTERN` is mirrored byte-for-byte in
 * `@atomicmemory/llmwiki`'s importer-side `project-id.ts`. When you
 * change either, change both.
 *
 * `projectId` participates in the deterministic external IDs
 * (`llmwiki/<projectId>/<pageDirectory>/<slug>`) used by downstream
 * importers and the Atomic Memory namespace scope. It is therefore a
 * **security boundary**, not just a dedup aid: two projects supplying
 * the same `projectId` collide and silently overwrite each other
 * through any upsert primitive.
 *
 * Three guards apply:
 *
 *   1. Strict regex at the boundary (export side here; import side
 *      mirrors).
 *   2. The Atomic Memory write scope must authorize the namespace
 *      (enforced server-side by the adapter; out of scope for the
 *      exporter).
 *   3. Collision detection on import when an existing record's
 *      `source` field differs (also import side).
 *
 * The regex below pins the on-wire format: lowercase letters, digits,
 * and hyphens; must begin with letter or digit; 1..63 characters. The
 * length cap matches DNS-label conventions and keeps external IDs
 * fitting comfortably inside Atomic Memory's metadata indexing limits.
 */

/** Regex pinning the on-wire `projectId` format. Mirrored on the importer side. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate a candidate `projectId`. Returns the input string when the
 * input is valid; throws `Error` with a clear, actionable message
 * otherwise. The thrown message names the rejected value verbatim so
 * shell users see what they typed.
 */
export function validateProjectId(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new Error(`projectId must be a string; received ${typeof candidate}`);
  }
  if (candidate.length === 0) {
    throw new Error("projectId must not be empty");
  }
  if (!PROJECT_ID_PATTERN.test(candidate)) {
    throw new Error(
      `Invalid projectId "${candidate}". ` +
        `Must match /^[a-z0-9][a-z0-9-]{0,62}$/ (lowercase letters, digits, hyphens; ` +
        `starts with letter or digit; max 63 characters).`,
    );
  }
  return candidate;
}
