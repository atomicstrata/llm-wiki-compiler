/**
 * @file src/utils/short-digest.ts
 * @description The short digest compile's signatures and cache keys use: the
 * first 16 hex characters of the SHA-256 of a value's JSON. One definition, so
 * the signatures every step compares across runs can never drift apart.
 */

import { createHash } from "node:crypto";

/** The 16-hex-character SHA-256 digest of `value`'s JSON. */
export function shortDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
