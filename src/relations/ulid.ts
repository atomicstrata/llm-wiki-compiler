/**
 * @file src/relations/ulid.ts
 * @description A small, dependency-free ULID generator used to mint relation
 * ids. A ULID is 26 Crockford base32 characters: a 48-bit millisecond
 * timestamp (10 chars) followed by 80 bits of randomness (16 chars). The
 * timestamp prefix makes ids roughly sortable by creation time; the random
 * suffix makes collisions within a millisecond astronomically unlikely.
 *
 * `Date.now()` and `crypto.randomBytes` are appropriate here: this is
 * PRODUCTION code, not a workflow script. (The Date.now ban applies only to
 * the workflow scripts.) We implement the encoding ourselves rather than add a
 * dependency.
 */

import { randomBytes } from "node:crypto";
import type { RelationId } from "./types.js";

/** Crockford base32 alphabet (no I, L, O, U to avoid visual ambiguity). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Base32 chars encoding the 48-bit timestamp portion. */
const TIME_CHARS = 10;
/** Base32 chars encoding the 80-bit random portion. */
const RANDOM_CHARS = 16;
/** Bits consumed per Crockford base32 character. */
const BITS_PER_CHAR = 5;

/** Encode a 48-bit millisecond timestamp as 10 Crockford base32 chars. */
function encodeTime(ms: number): string {
  let remaining = ms;
  const out: string[] = new Array(TIME_CHARS);
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    out[i] = CROCKFORD[remaining % 32];
    remaining = Math.floor(remaining / 32);
  }
  return out.join("");
}

/**
 * Encode 80 random bits as 16 Crockford base32 chars. We draw the 80 bits as
 * 10 bytes and walk them as a bit stream, emitting one base32 char per 5 bits.
 */
function encodeRandom(): string {
  const bytes = randomBytes(10);
  let bitBuffer = 0;
  let bitCount = 0;
  const out: string[] = [];
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= BITS_PER_CHAR) {
      bitCount -= BITS_PER_CHAR;
      out.push(CROCKFORD[(bitBuffer >>> bitCount) & 0x1f]);
    }
  }
  return out.join("").slice(0, RANDOM_CHARS);
}

/**
 * Generate a 26-character Crockford base32 ULID: 48-bit `Date.now()` time
 * prefix + 80 random bits.
 *
 * @returns A 26-char uppercase ULID string.
 */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

/**
 * Mint a fresh relation id of the form `rel_<ULID>`. Allocated once at relation
 * creation and never recomputed from content.
 *
 * @returns A new `rel_<ULID>` id.
 */
export function mintRelationId(): RelationId {
  return `rel_${ulid()}`;
}
