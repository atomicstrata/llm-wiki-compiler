/**
 * Canonical profile digest.
 *
 * A profile digest is the durable identity of a profile pack: it is recorded
 * alongside compiled artifacts so that a re-compile can detect whether the
 * governing profile changed. Because that identity must be byte-stable across
 * cosmetic edits (key reordering, whitespace, equivalent number spellings),
 * the digest is computed over the RFC 8785 JSON Canonicalization Scheme (JCS)
 * form of the pack, not its raw serialization.
 *
 * Canonicalization is intentionally NOT hand-rolled. JCS has subtle rules
 * (lexicographic UTF-16 key ordering, ECMAScript Number serialization, string
 * escaping) where a bespoke implementation would silently diverge and corrupt
 * identity. We therefore depend on `canonicalize`, a small, well-known, vetted
 * RFC 8785 implementation — the one permitted new runtime dependency for this
 * capability — and layer only a SHA-256 over its output.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { ProfilePack } from "./types.js";

/**
 * Compute the durable digest of a profile pack.
 *
 * Returns the lowercase-hex SHA-256 of the RFC 8785 (JCS) canonicalization of
 * `p`. The digest is stable under key reordering, whitespace, and equivalent
 * numeric spellings (e.g. `1.0` vs `1`), so equal profiles yield equal digests.
 *
 * @param p - The profile pack to digest.
 * @returns Lowercase hex-encoded SHA-256 of the canonical JSON form.
 */
export function profileDigest(p: ProfilePack): string {
  const canonical = canonicalize(p);
  if (canonical === undefined) {
    throw new Error("profile canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
