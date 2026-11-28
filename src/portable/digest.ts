/**
 * @file src/portable/digest.ts
 * @description The two digest forms the portable path uses, and nothing else.
 *
 * A {@link bytesDigest} is over exact bytes, so it equals the content digest of
 * whatever is later stored: this is what makes "the reviewed draft is the
 * published page" checkable. Every other digest is a {@link recordDigest} over
 * RFC 8785 canonical JSON — the canonicalization the event store already uses —
 * so key order and whitespace can never change what a record hashes to.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { ContentDigest } from "./contracts.js";

/** SHA-256 of exact bytes. */
export function bytesDigest(bytes: Uint8Array): ContentDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** SHA-256 of the exact UTF-8 bytes of `text`, with no canonicalization. */
export function textDigest(text: string): ContentDigest {
  return bytesDigest(Buffer.from(text, "utf8"));
}

/** SHA-256 over the RFC 8785 canonical JSON of `value`. */
export function recordDigest(value: unknown): ContentDigest {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error("value has no canonical JSON form");
  return textDigest(canonical);
}

/** The stored bytes of a record: canonical JSON, so re-hashing is stable. */
export function recordBytes(value: unknown): Uint8Array {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error("value has no canonical JSON form");
  return Buffer.from(canonical, "utf8");
}

/** Sorted, de-duplicated labels. */
export function normalizeLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort();
}
