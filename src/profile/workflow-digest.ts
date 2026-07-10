/**
 * Canonical per-workflow digest.
 *
 * A workflow digest is the durable identity of a SINGLE declarative workflow
 * sub-object (one `WorkflowDef`), not the whole profile. Scoping the digest to
 * the one sub-object means reformatting the surrounding profile or editing an
 * unrelated section leaves a given workflow's digest stable, while any change to
 * the workflow's own stages flips it.
 *
 * As with the profile digest, canonicalization is intentionally NOT hand-rolled:
 * RFC 8785 (JCS) has subtle rules (lexicographic UTF-16 key ordering, ECMAScript
 * Number serialization, string escaping) where a bespoke implementation would
 * silently diverge and corrupt identity. We therefore depend on `canonicalize`,
 * the same vetted RFC 8785 implementation used by the profile digest, and layer
 * only a SHA-256 over its output.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { WorkflowDef } from "./types.js";

/**
 * Compute the durable digest of a single workflow definition.
 *
 * Returns the lowercase-hex SHA-256 of the RFC 8785 (JCS) canonicalization of
 * `def` ALONE (the one workflow sub-object, never the whole profile). The digest
 * is stable under key reordering and whitespace, so an equal def yields an equal
 * digest, while adding or editing a stage changes it.
 *
 * @param def - The workflow definition to digest.
 * @returns Lowercase hex-encoded SHA-256 of the canonical JSON form.
 */
export function workflowDefDigest(def: WorkflowDef): string {
  const canonical = canonicalize(def);
  if (canonical === undefined) {
    throw new Error("workflow canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
